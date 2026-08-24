import path from "node:path";
import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { mkdir, readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { prisma } from "@/lib/db";
import { extractPdfText } from "@/lib/pdf";
import { recheckOfficialUrl } from "@/lib/sync/verify";
import { checkJobForFraud } from "@/lib/sync/fraudCheck";
import { notifyWindows } from "@/lib/gmail/notify";
import { fillApplicationForAts } from "./adapters";
import { logAudit } from "./audit";
import { normalizeQuestionText } from "./approvedAnswers";
import { classifyErrorCode, type AtsType, type FillContext } from "./types";
import { getApplicationSettings } from "./settings";
import { applicationNarrativeForUser, fillContextProfile } from "./fillProfile";
import { assertGeneratedDocumentUploadable } from "@/lib/documents/identityGuard";
import { isUsableResume } from "@/lib/documents/strategy";
import { captureApplicationStep } from "./browserAgent";
import { BrowserManager, BrowserRestartFailedError, isClosedContextError } from "./browserManager";
import { navigateToApplicationForm, ApplicationNavigationError } from "./navigation";
import { recordRunStage, validateAndNormalizeApplicationRun } from "./validation";

function absolute(relativePath: string): string {
  return path.isAbsolute(relativePath) ? relativePath : path.join(process.cwd(), relativePath);
}

/**
 * Process one already-claimed run using the context owned by the daemon.
 * This module never launches Chromium and is never invoked by an API route.
 */
export async function processApplicationRun(
  runId: string,
  browserManager: BrowserManager,
): Promise<{ runId: string; status: string }> {
  const initialRun = await prisma.applicationRun.findUnique({
    where: { id: runId },
    include: {
      job: {
        include: {
          matchResults: { orderBy: { createdAt: "desc" }, take: 1 },
          generatedDocuments: { orderBy: { createdAt: "desc" } },
          applicationRuns: true,
        },
      },
    },
  });
  if (!initialRun || initialRun.status !== "running") throw new Error("The queued application run was not claimed by this worker.");
  let run = initialRun;
  let job = initialRun.job;
  let applicationPage: Page | null = null;
  let keepApplicationPage = false;

  try {
    const validated = await validateAndNormalizeApplicationRun(runId);
    const refreshedRun = await prisma.applicationRun.findUnique({
      where: { id: runId },
      include: {
        job: {
          include: {
            matchResults: { orderBy: { createdAt: "desc" }, take: 1 },
            generatedDocuments: { orderBy: { createdAt: "desc" } },
            applicationRuns: true,
          },
        },
      },
    });
    if (!refreshedRun) throw new Error("Validated application run disappeared before processing.");
    run = refreshedRun;
    job = run.job;
    const officialApplyUrl = validated.officialApplyUrl;
    if (job.verificationStatus !== "VERIFIED_OFFICIAL_AT_LAST_CHECK") {
      throw new Error("The posting is no longer verified; the worker did not open it.");
    }
    if (job.applicationRuns.some((item) => item.id !== run.id && item.status === "submitted")) {
      throw new Error("This requisition is already recorded as submitted.");
    }
    const latestMatch = job.matchResults[0];
    if (!latestMatch || latestMatch.eligibility === "Fail") throw new Error("Eligibility is no longer Pass or Unknown.");
    if (!officialApplyUrl.startsWith("https://") && job.source !== "application-worker-test") throw new Error("Validated officialApplyUrl is not HTTPS.");

    const recheck = await recheckOfficialUrl(officialApplyUrl);
    // Only a CONFIRMED closure (genuine 404/410) blocks the run and marks the
    // job Closed. A transient/inconclusive failure ("pending") does not close
    // the posting — the worker proceeds with the fill.
    if (recheck.availability === "closed") {
      await prisma.job.update({ where: { id: job.id }, data: { verificationStatus: "Closed", reasonCode: recheck.reasonCode, verificationReason: recheck.reason } });
      throw new Error(`The posting is no longer open: ${recheck.reason}`);
    }

    const fraudSignals = await checkJobForFraud(job.id, [job.description]);
    if (fraudSignals.length) throw new Error(`Fraud protection stopped this run: ${fraudSignals.map((signal) => signal.reason).join(", ")}`);

    // Any QA-passed, identity-verified resume is usable (including a
    // master-resume fallback). Tailoring completeness never blocks the run.
    const resumeDoc = job.generatedDocuments.find((document) =>
      document.id === run.resumeDocumentId && isUsableResume(document),
    );
    if (!resumeDoc) throw new Error("The queued resume is missing or no longer QA-approved.");
    const coverLetterDoc = job.generatedDocuments.find((document) =>
      document.id === run.coverLetterDocumentId
      && document.type === "coverLetter"
      && document.qaStatus === "pass"
      && document.identityVerified,
    );
    // The run carries its owner, so the worker fills from that person's
    // profile. There is no installation profile to fall back to, and a run with
    // no owner is a legacy row that must not be filled from anybody's data.
    if (!run.userId) throw new Error("This application run has no owner and cannot be filled.");
    const profile = await applicationProfileForUser(run.userId);
    if (!profile) throw new Error("No Application Profile is saved.");
    // Degree and most recent role come from this user's own history, never from
    // a module constant holding somebody else's résumé.
    const narrative = await applicationNarrativeForUser(run.userId);
    await assertGeneratedDocumentUploadable(resumeDoc.id);
    if (coverLetterDoc) await assertGeneratedDocumentUploadable(coverLetterDoc.id);

    let coverLetterText: string | null = null;
    if (coverLetterDoc) {
      try {
        const extraction = await extractPdfText(new Uint8Array(await readFile(absolute(coverLetterDoc.storagePath))));
        coverLetterText = extraction.text;
      } catch {
        coverLetterText = null;
      }
    }

    // The daemon is permanently restricted to Fill To Submit. No setting,
    // queued row, score, or allowlist can authorize a final click.
    const mode = "fill_to_submit" as const;
    const fillContext: FillContext = {
      jobId: job.id,
      runId: run.id,
      jobTitle: job.title,
      company: job.company,
      applyUrl: officialApplyUrl,
      mode,
      profile: fillContextProfile(profile),
      resumeFilePath: resumeDoc.storagePath,
      coverLetterFilePath: coverLetterDoc?.storagePath ?? null,
      coverLetterText,
      ...narrative,
      approvedRunAnswers: parseRunAnswers(run.answers),
    };

    await logAudit({
      jobId: job.id,
      actor: "application-agent",
      action: "application-run-started",
      detail: `Background worker started Fill To Submit run for "${job.title}" at ${job.company}.`,
      metadata: { runId: run.id, atsType: run.atsType },
    });

    const outputRoot = process.env.APPLICATION_OUTPUT_DIR ?? "data/generated";
    const runDirectory = path.join(outputRoot, job.id, "application-runs", run.id);
    await mkdir(absolute(runDirectory), { recursive: true });
    await prisma.applicationRun.update({
      where: { id: run.id },
      data: { currentStep: "STARTING_BROWSER" },
    });
    await recordRunStage(run.id, "STARTING_BROWSER", "Checking the worker-owned BrowserManager before creating this run's page.");
    const resumePausedRun = Boolean(
      initialRun.stoppedFieldContext
      || initialRun.stoppedFieldLabel
      || parseStageHistory(initialRun.stageHistory).some((entry) => entry.stage === "NEEDS_USER_ACTION"),
    );
    const acquiredPage = await browserManager.acquireRunPage(run.id, resumePausedRun);
    applicationPage = acquiredPage.page;
    const page = applicationPage;
    await page.addInitScript(() => {
      const browserWindow = window as unknown as { __name?: (fn: unknown, name: string) => unknown };
      browserWindow.__name = browserWindow.__name || ((fn: unknown) => fn);
    });
    await captureApplicationStep(page, fillContext, runDirectory, "browser-started", 0, { useModel: false });
    await prisma.applicationRun.update({ where: { id: run.id }, data: { currentStep: "NAVIGATING" } });
    await recordRunStage(
      run.id,
      "NAVIGATING",
      acquiredPage.reused
        ? `Resuming the same paused page at ${page.url()}.`
        : `Navigating to ${officialApplyUrl}.`,
    );
    try {
      const inspection = await navigateToApplicationForm(
        page,
        officialApplyUrl,
        run.atsType as AtsType,
        (detail) => recordRunStage(run.id, "PAGE_LOADED", detail),
      );
      await captureApplicationStep(page, fillContext, runDirectory, "page-loaded", 0, { useModel: false });
      if (!inspection.formDetected) {
        throw new ApplicationNavigationError(
          `No readable application form fields were detected at ${inspection.finalUrl}.`,
          officialApplyUrl,
          inspection.finalUrl,
          inspection.httpStatus,
        );
      }
      await recordRunStage(run.id, "READING_FORM", `Detected ${inspection.fieldCount} visible form fields at ${inspection.finalUrl}.`);
    } catch (error) {
      const screenshotPath = `${runDirectory}/navigation-failed.png`;
      await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
      await prisma.applicationRun.update({ where: { id: run.id }, data: { screenshotPath } }).catch(() => {});
      if (error instanceof ApplicationNavigationError) {
        throw new Error(`${error.message}\nAttempted URL: ${error.attemptedUrl}\nFinal URL: ${error.finalUrl || "(empty)"}\nHTTP status: ${error.httpStatus ?? "unavailable"}\nScreenshot: ${screenshotPath}`);
      }
      throw error;
    }

      const renderedText = (await page.locator("body").innerText().catch(() => "")) || "";
      const pageSignals = await checkJobForFraud(job.id, [renderedText]);
      if (pageSignals.length) {
        await recordRunStage(run.id, "NEEDS_USER_ACTION", "Security quarantine requires manual review.");
        const screenshotPath = `${runDirectory}/stopped-security_quarantine.png`;
        await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
        const result = await prisma.applicationRun.update({
          where: { id: run.id },
          data: {
            status: "needs_user_action",
            currentStep: "NEEDS_USER_ACTION",
            needsUserActionReason: "security_quarantine",
            stoppedFieldLabel: "Security review required",
            stoppedFieldType: "page_intervention",
            stoppedFieldOptions: "[]",
            stoppedFieldStep: 1,
            stoppedFieldContext: JSON.stringify({ required: true, ariaLabel: "", placeholder: "", nearbyText: renderedText.slice(0, 300), pageUrl: page.url() }),
            screenshotPath,
            finishedAt: null,
          },
        });
        await prisma.job.update({ where: { id: job.id }, data: { status: "NEEDS_USER_ACTION" } });
        keepApplicationPage = true;
        return { runId: result.id, status: result.status };
      }

      await prisma.applicationRun.update({ where: { id: run.id }, data: { currentStep: "FILLING" } });
      await recordRunStage(run.id, "FILLING", "The extension is filling only deterministic, evidence-backed fields.");
      const beforeFinalReview = async () => {
        const secondCheck = await recheckOfficialUrl(officialApplyUrl);
        return { ok: secondCheck.stillOpen, reason: secondCheck.reason };
      };
      const result = await fillApplicationForAts(
        page,
        run.atsType as AtsType,
        fillContext,
        runDirectory,
        beforeFinalReview,
      );

      // A Fill To Submit worker treats any impossible "submitted" result as
      // a failure instead of recording or continuing an automated submit.
      if (result.status === "submitted") throw new Error("Safety invariant violation: an adapter reported a submission in Fill To Submit mode.");

      const needsFallback = result.status === "needs_user_action" && !result.stoppedField;
      const fallbackScreenshot = needsFallback && !result.screenshotPath ? `${runDirectory}/stopped-${result.stopReason ?? "user_action"}.png` : null;
      if (fallbackScreenshot) await page.screenshot({ path: absolute(fallbackScreenshot), fullPage: true }).catch(() => {});
      const stoppedField = result.stoppedField ?? (needsFallback ? {
        label: result.stoppedFieldLabel || "(Label unavailable)",
        type: "page_intervention",
        required: true,
        options: [],
        step: 1,
        ariaLabel: "",
        placeholder: "",
        nearbyText: renderedText.slice(0, 300),
        pageUrl: page.url(),
      } : undefined);
      const terminal = result.status !== "needs_user_action";
      const finalStage = result.status === "filled" ? "FINAL_REVIEW" : result.status === "needs_user_action" ? "NEEDS_USER_ACTION" : "FAILED";
      const actionMessage = result.status === "needs_user_action"
        ? pauseMessage(result.stopReason)
        : result.status === "filled"
          ? "Form filled; Submit remains manual."
          : result.error ?? result.status;
      await recordRunStage(run.id, finalStage, actionMessage);
      const updated = await prisma.applicationRun.update({
        where: { id: run.id },
        data: {
          activeKey: terminal ? null : job.id,
          mode,
          status: result.status,
          needsUserActionReason: result.stopReason ?? null,
          stoppedFieldLabel: stoppedField?.label ?? null,
          stoppedFieldType: stoppedField?.type ?? null,
          stoppedFieldOptions: stoppedField ? JSON.stringify(stoppedField.options) : null,
          stoppedFieldStep: stoppedField?.step ?? null,
          stoppedFieldContext: stoppedField ? JSON.stringify({
            required: stoppedField.required,
            ariaLabel: stoppedField.ariaLabel,
            placeholder: stoppedField.placeholder,
            nearbyText: stoppedField.nearbyText,
            pageUrl: stoppedField.pageUrl,
          }) : null,
          currentStep: finalStage,
          answers: JSON.stringify(result.answers),
          screenshotPath: result.screenshotPath ?? fallbackScreenshot,
          confirmationNumber: null,
          confirmationUrl: null,
          errorLog: result.status === "needs_user_action" ? null : result.error ?? null,
          errorCode: result.status === "failed" ? (classifyErrorCode(result.error).errorCode) : null,
          validationPath: result.status === "failed" ? (classifyErrorCode(result.error).validationPath ?? null) : null,
          finishedAt: terminal ? new Date() : null,
        },
      });
      // The tracker moves for the applicant whose run this is. Writing
      // `Job.status` moved the posting for everyone who could see it.
      const runStatus =
        result.status === "needs_user_action"
          ? "NEEDS_USER_ACTION"
          : result.status === "filled"
            ? "READY_TO_APPLY"
            : "FAILED";
      await prisma.userJobState.upsert({
        where: { userId_jobId: { userId: run.userId, jobId: job.id } },
        create: { userId: run.userId, jobId: job.id, applicationStatus: runStatus },
        update: { applicationStatus: runStatus },
      });
      if (result.status === "filled") {
        notifyWindows("Ready for your final review", `${job.title} at ${job.company} is filled in. Submit remains entirely manual.`);
      }
      const appSettings = await getApplicationSettings(run.userId).catch(() => null);
      const keepFailedOpen = appSettings?.keepFailedApplicationOpen !== false;
      keepApplicationPage = result.status === "needs_user_action" || result.status === "filled" || (result.status === "failed" && keepFailedOpen);
      await prisma.applicationRun.update({
        where: { id: run.id },
        data: { tabRemainsOpen: keepApplicationPage },
      }).catch(() => {});
      await logAudit({
        userId: run.userId,
        jobId: job.id,
        actor: "application-agent",
        action: `application-run-${result.status}`,
        detail: result.status === "needs_user_action"
          ? `Paused the same run for user action: ${result.stopReason}.`
          : result.status === "filled"
            ? "Form filled for manual final review. Submit was not clicked."
            : `Run failed: ${result.error ?? "unknown error"}.`,
        metadata: { runId: run.id, stopReason: result.stopReason, keepOpen: keepApplicationPage },
      });
      return { runId: updated.id, status: updated.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const technical = error instanceof Error ? error.stack ?? error.message : String(error);
    const appSettings = run.userId
      ? await getApplicationSettings(run.userId).catch(() => null)
      : null;
    const keepFailedOpen = appSettings?.keepFailedApplicationOpen !== false;
    keepApplicationPage = keepFailedOpen;
    const classified = classifyErrorCode(message);
    if (error instanceof BrowserRestartFailedError || isClosedContextError(error)) {
      await recordRunStage(run.id, "BROWSER_RESTART_FAILED", message).catch(() => {});
    }
    await recordRunStage(run.id, "FAILED", message).catch(() => {});
    await prisma.applicationRun.update({
      where: { id: run.id },
      data: {
        activeKey: null,
        status: "failed",
        currentStep: "FAILED",
        errorLog: technical,
        errorCode: classified.errorCode,
        validationPath: classified.validationPath ?? null,
        tabRemainsOpen: keepApplicationPage,
        finishedAt: new Date(),
      },
    });
    await prisma.job.update({ where: { id: job.id }, data: { status: "FAILED" } });
    await logAudit({
      jobId: job.id,
      actor: "application-agent",
      action: "application-run-failed",
      detail: `Background run stopped: ${message}`,
      metadata: { runId: run.id, keepOpen: keepApplicationPage },
    });
    return { runId: run.id, status: "failed" };
  } finally {
    if (applicationPage) {
      await browserManager.finishRunPage(run.id, applicationPage, keepApplicationPage).catch(() => {});
    }
  }
}

function parseRunAnswers(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => [normalizeQuestionText(key), value]),
    );
  } catch {
    return {};
  }
}

function parseStageHistory(json: string | null): Array<{ stage: string }> {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((entry): entry is { stage: string } => Boolean(entry && typeof entry.stage === "string"))
      : [];
  } catch {
    return [];
  }
}

function pauseMessage(reason: string | undefined): string {
  if (reason === "captcha") return "Complete the CAPTCHA in the application browser, then click Resume.";
  if (reason === "mfa") return "Complete MFA in the application browser, then click Resume.";
  if (reason === "login_required") return "Log in in the application browser, then click Resume.";
  return reason ? `Paused for user action: ${reason}.` : "Paused for user action.";
}
