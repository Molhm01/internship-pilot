import { prisma } from "@/lib/db";
import { readUserSetting, writeUserSetting } from "@/lib/userSettings";
import { ensureStarterProfile, ensureWorkspaceBootstrapped, runLiveDiscoveryCycle } from "@/lib/bootstrap";
import {
  buildEffectiveMatchDescription,
  runMatchForJob,
  scoreAllActiveJobsImmediately,
  scoreSingleJobImmediate,
} from "@/lib/matching";
import { pruneStaleActiveJobs } from "@/lib/jobs/activeFeed";
import { hasUsableJobDescription } from "@/lib/matchWorkflow";
import { ensureCleanAutonomousDocuments } from "@/lib/documents/generate";
import { isUsableResume, strategyFromTailoringStatus, jobDescriptionCompleteness, documentStrategyReason } from "@/lib/documents/strategy";
import { tailoredFilename } from "@/lib/documents/agentDelivery";
import { readStoredObject } from "@/lib/storage";
import { extractPdfText } from "@/lib/pdf";
import { detectAtsFromText } from "@/lib/ats/detect";
import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { applicationNarrativeForUser, fillContextProfile } from "@/lib/applications/fillProfile";
import { normalizeQuestionText } from "@/lib/applications/approvedAnswers";
import { applicationActiveKey } from "@/lib/applications/queue";
import { logAudit } from "@/lib/applications/audit";
import { checkJobForFraud } from "@/lib/sync/fraudCheck";
import { AVAILABILITY, canonicalAvailability, isActiveAvailability } from "@/lib/jobs/verificationModel";
import { classifyErrorCode, type AtsType, type FillContext } from "@/lib/applications/types";
import { inspectAndRunRemoteApplication } from "@/lib/applications/remoteAgent";
import { resolveAggregatorJobToOfficialAts } from "@/lib/applications/companyBoardResolver";
import { isAggregatorUrl } from "@/lib/applications/officialDestination";
import { DEFAULT_PORTAL_EMAIL, DEFAULT_PORTAL_PASSWORD } from "@/lib/applications/autonomousSolver";

const AUTOPILOT_CONFIG_KEY = "autopilotConfig";
const AUTOPILOT_SUMMARY_KEY = "autopilotLastSummary";
const PORTAL_CREDENTIALS_KEY = "portalCredentials";

export interface PortalCredentialsConfig {
  email: string;
  password: string;
}

export type AutopilotMode = "auto_submit" | "fill_to_submit";

export interface AutopilotConfig {
  enabled: boolean;
  mode: AutopilotMode;
  minScore: number;
  maxPerCycle: number;
  discoverFresh: boolean;
}

export interface AutopilotRunOutcome {
  runId: string;
  jobId: string;
  jobTitle: string;
  company: string;
  atsType: string;
  status: string;
  matchScore: number | null;
  confirmationNumber: string | null;
  stoppedFieldLabel: string | null;
  detail: string;
}

export interface AutopilotCycleSummary {
  ranAt: string;
  mode: AutopilotMode;
  discovered: number;
  scored: number;
  attempted: number;
  submitted: number;
  filled: number;
  needsUserAction: number;
  failed: number;
  runs: AutopilotRunOutcome[];
}

export const DEFAULT_AUTOPILOT_CONFIG: AutopilotConfig = {
  enabled: false,
  mode: "auto_submit",
  minScore: 45,
  maxPerCycle: 10,
  discoverFresh: false,
};

const globalForInflight = globalThis as unknown as {
  __pilotInflightJobRuns?: Map<string, Promise<AutopilotRunOutcome>>;
};

function inflightJobRunsMap(): Map<string, Promise<AutopilotRunOutcome>> {
  if (!globalForInflight.__pilotInflightJobRuns) {
    globalForInflight.__pilotInflightJobRuns = new Map<string, Promise<AutopilotRunOutcome>>();
  }
  return globalForInflight.__pilotInflightJobRuns;
}

async function clearStaleActiveKeys(activeKey: string, keepRunId?: string): Promise<void> {
  const existing = await prisma.applicationRun.findMany({
    where: { activeKey },
  });
  for (const row of existing) {
    if (keepRunId && row.id === keepRunId) continue;
    const isStaleRunning =
      row.status === "running"
      && Date.now() - new Date(row.startedAt ?? row.createdAt).getTime() > 3 * 60 * 1000;
    await prisma.applicationRun.update({
      where: { id: row.id },
      data: {
        activeKey: null,
        ...(isStaleRunning
          ? {
              status: "failed",
              currentStep: "FAILED",
              errorLog: "Recovered stale interrupted run automatically.",
              finishedAt: new Date(),
            }
          : {}),
      },
    });
  }
}

export async function recoverStaleRunningRuns(userId: string): Promise<number> {
  const running = await prisma.applicationRun.findMany({
    where: { userId, status: "running" },
  });
  let recovered = 0;
  const inflight = inflightJobRunsMap();
  for (const row of running) {
    const key = `${userId}:${row.jobId}`;
    if (inflight.has(key)) continue;
    const ageMs = Date.now() - new Date(row.startedAt ?? row.createdAt).getTime();
    if (ageMs < 90_000) continue;
    await prisma.applicationRun.update({
      where: { id: row.id },
      data: {
        activeKey: null,
        status: "failed",
        currentStep: "FAILED",
        errorLog: "Recovered stale interrupted run automatically.",
        finishedAt: new Date(),
      },
    });
    recovered += 1;
  }
  return recovered;
}

export async function getAutopilotConfig(userId: string): Promise<AutopilotConfig> {
  const saved = await readUserSetting<Partial<AutopilotConfig>>(userId, AUTOPILOT_CONFIG_KEY, {});
  return {
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULT_AUTOPILOT_CONFIG.enabled,
    mode: saved.mode === "fill_to_submit" ? "fill_to_submit" : "auto_submit",
    minScore:
      typeof saved.minScore === "number" && Number.isFinite(saved.minScore)
        ? Math.min(100, Math.max(0, Math.round(saved.minScore)))
        : DEFAULT_AUTOPILOT_CONFIG.minScore,
    maxPerCycle:
      typeof saved.maxPerCycle === "number" && Number.isFinite(saved.maxPerCycle)
        ? Math.min(25, Math.max(1, Math.round(saved.maxPerCycle)))
        : DEFAULT_AUTOPILOT_CONFIG.maxPerCycle,
    discoverFresh:
      typeof saved.discoverFresh === "boolean" ? saved.discoverFresh : DEFAULT_AUTOPILOT_CONFIG.discoverFresh,
  };
}

export async function setAutopilotConfig(
  userId: string,
  partial: Partial<AutopilotConfig>,
): Promise<AutopilotConfig> {
  const current = await getAutopilotConfig(userId);
  const next: AutopilotConfig = {
    enabled: typeof partial.enabled === "boolean" ? partial.enabled : current.enabled,
    mode:
      partial.mode === "fill_to_submit"
        ? "fill_to_submit"
        : partial.mode === "auto_submit"
          ? "auto_submit"
          : current.mode,
    minScore:
      typeof partial.minScore === "number" && Number.isFinite(partial.minScore)
        ? Math.min(100, Math.max(0, Math.round(partial.minScore)))
        : current.minScore,
    maxPerCycle:
      typeof partial.maxPerCycle === "number" && Number.isFinite(partial.maxPerCycle)
        ? Math.min(25, Math.max(1, Math.round(partial.maxPerCycle)))
        : current.maxPerCycle,
    discoverFresh: typeof partial.discoverFresh === "boolean" ? partial.discoverFresh : current.discoverFresh,
  };
  await writeUserSetting(userId, AUTOPILOT_CONFIG_KEY, next);
  return next;
}

export async function getAutopilotLastSummary(userId: string): Promise<AutopilotCycleSummary | null> {
  return readUserSetting<AutopilotCycleSummary | null>(userId, AUTOPILOT_SUMMARY_KEY, null);
}

export async function getPortalCredentials(userId: string): Promise<PortalCredentialsConfig> {
  const [saved, profile] = await Promise.all([
    readUserSetting<Partial<PortalCredentialsConfig>>(userId, PORTAL_CREDENTIALS_KEY, {}),
    applicationProfileForUser(userId),
  ]);
  const rawSavedEmail = saved.email?.trim() ?? "";
  const rawProfileEmail = profile?.email?.trim() ?? "";
  const normalizedSaved = rawSavedEmail.toLowerCase() === "molhmalasri7@gmail.com" ? DEFAULT_PORTAL_EMAIL : rawSavedEmail;
  const normalizedProfile = rawProfileEmail.toLowerCase() === "molhmalasri7@gmail.com" ? DEFAULT_PORTAL_EMAIL : rawProfileEmail;
  const email = normalizedSaved || normalizedProfile || DEFAULT_PORTAL_EMAIL;
  const password = (saved.password && saved.password.trim()) || DEFAULT_PORTAL_PASSWORD;

  if (rawSavedEmail.toLowerCase() === "molhmalasri7@gmail.com") {
    await writeUserSetting(userId, PORTAL_CREDENTIALS_KEY, { email, password }).catch(() => undefined);
  }

  return { email, password };
}

export async function setPortalCredentials(
  userId: string,
  partial: Partial<PortalCredentialsConfig>,
): Promise<PortalCredentialsConfig> {
  const current = await getPortalCredentials(userId);
  const next: PortalCredentialsConfig = {
    email: (partial.email && partial.email.trim()) || current.email,
    password: (partial.password && partial.password.trim()) || current.password,
  };
  await writeUserSetting(userId, PORTAL_CREDENTIALS_KEY, next);
  return next;
}

function parseRunAnswers(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function parseStageList(json: string | null): Array<{ stage: string; at: string; detail?: string }> {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function executeApplicationRunNow(
  runId: string,
  userId: string,
  options: { mode?: AutopilotMode; gmailAccessToken?: string | null } = {},
): Promise<AutopilotRunOutcome> {
  const run = await prisma.applicationRun.findFirst({
    where: { id: runId, userId },
    include: {
      job: {
        include: {
          matchResults: { where: { userId }, orderBy: { createdAt: "desc" }, take: 1 },
          generatedDocuments: { where: { userId }, orderBy: { createdAt: "desc" } },
        },
      },
    },
  });

  if (!run) {
    throw new Error("Application run not found for current workspace.");
  }

  const job = run.job;
  const effectiveMode: AutopilotMode =
    options.mode ?? (run.mode === "fill_to_submit" ? "fill_to_submit" : "auto_submit");
  const history = parseStageList(run.stageHistory);
  const addStage = (stage: string, detail: string) => {
    history.push({ stage, at: new Date().toISOString(), detail });
  };

  addStage("RUNNING", `Autonomous agent claimed run in ${effectiveMode} mode.`);
  await prisma.applicationRun.update({
    where: { id: run.id },
    data: {
      status: "running",
      mode: effectiveMode,
      currentStep: "RUNNING",
      startedAt: run.startedAt ?? new Date(),
      stageHistory: JSON.stringify(history.slice(-100)),
    },
  });

  try {
    let officialApplyUrl = job.officialApplyUrl ?? job.url ?? job.officialJobUrl ?? job.sourceUrl;
    let effectiveAtsType = job.atsType;
    let effectiveAtsTenant = job.atsTenant;

    if (!officialApplyUrl || job.resolutionStatus !== "RESOLVED" || isAggregatorUrl(officialApplyUrl)) {
      const resolution = await resolveAggregatorJobToOfficialAts(job.id);
      if (resolution.resolved && resolution.url) {
        officialApplyUrl = resolution.url;
        if (resolution.atsType) effectiveAtsType = resolution.atsType;
        effectiveAtsTenant = detectAtsFromText(resolution.url).atsIdentifier ?? effectiveAtsTenant;
        addStage(
          "ATS_RESOLVED",
          `Resolved aggregator listing to official ${(effectiveAtsType ?? "unknown").toUpperCase()} portal (${resolution.method}).`,
        );
      }
    }

    if (!officialApplyUrl) {
      throw new Error("This posting has no usable application URL.");
    }
    if (isAggregatorUrl(officialApplyUrl)) {
      throw new Error(
        `This posting points to ${new URL(officialApplyUrl).hostname} instead of the employer's direct ATS page, and no official employer URL could be resolved automatically yet.`,
      );
    }

    const fraudSignals = await checkJobForFraud(job.id, [job.description ?? ""]);
    if (fraudSignals.length > 0) {
      throw new Error(`Fraud protection blocked run: ${fraudSignals.map((s) => s.reason).join(", ")}`);
    }

    const profile = await applicationProfileForUser(userId);
    if (!profile) {
      throw new Error("No Application Profile is saved for this workspace.");
    }
    const [narrative, portalCreds] = await Promise.all([
      applicationNarrativeForUser(userId),
      getPortalCredentials(userId),
    ]);

    const resumeDoc = job.generatedDocuments.find((d) => d.id === run.resumeDocumentId && isUsableResume(d))
      ?? job.generatedDocuments.find((d) => isUsableResume(d));
    if (!resumeDoc) {
      throw new Error("No QA-approved tailored resume document was available for this run.");
    }
    const coverLetterDoc = job.generatedDocuments.find(
      (d) => d.id === run.coverLetterDocumentId && d.type === "coverLetter" && d.qaStatus === "pass" && d.identityVerified,
    ) ?? job.generatedDocuments.find(
      (d) => d.type === "coverLetter" && d.qaStatus === "pass" && d.identityVerified,
    );

    const resumeBytes = await readStoredObject(resumeDoc.storagePath);
    let coverLetterBytes: Uint8Array | null = null;
    let coverLetterText: string | null = null;
    if (coverLetterDoc) {
      try {
        coverLetterBytes = await readStoredObject(coverLetterDoc.storagePath);
        const extracted = await extractPdfText(coverLetterBytes);
        coverLetterText = extracted.text;
      } catch {
        coverLetterBytes = null;
        coverLetterText = null;
      }
    }

    const existingAnswers = parseRunAnswers(run.answers);
    const normalizedExisting =
      run.status === "needs_user_action"
        ? Object.fromEntries(
            Object.entries(existingAnswers).map(([k, v]) => [normalizeQuestionText(k), v]),
          )
        : {};

    const fillContext: FillContext = {
      jobId: job.id,
      runId: run.id,
      jobTitle: job.title,
      company: job.company,
      applyUrl: officialApplyUrl,
      mode: effectiveMode,
      profile: fillContextProfile(profile, {
        portalEmail: portalCreds.email,
        portalPassword: portalCreds.password,
      }),
      resumeFilePath: resumeDoc.storagePath,
      coverLetterFilePath: coverLetterDoc?.storagePath ?? null,
      coverLetterText,
      ...narrative,
      approvedRunAnswers: normalizedExisting,
    };

    const resumeFilename = tailoredFilename("resume", job.company, job.title);
    const coverFilename = coverLetterDoc
      ? tailoredFilename("cover_letter", job.company, job.title)
      : null;

    const outcome = await inspectAndRunRemoteApplication(
      fillContext,
      userId,
      {
        resumeBytes,
        resumeFilename,
        coverLetterBytes,
        coverLetterFilename: coverFilename,
      },
      {
        atsType: effectiveAtsType,
        atsTenant: effectiveAtsTenant,
        gmailAccessToken: options.gmailAccessToken ?? null,
      },
    );

    for (const s of outcome.stages) {
      addStage(s.stage, s.detail);
    }

    const mergedAnswers = { ...existingAnswers, ...outcome.answers };
    const normalizedStatus: "submitted" | "filled" | "failed" =
      outcome.status === "submitted"
        ? "submitted"
        : outcome.status === "failed"
          ? "failed"
          : "filled";
    const finalStep =
      normalizedStatus === "submitted"
        ? "SUBMITTED"
        : normalizedStatus === "filled"
          ? "FINAL_REVIEW"
          : "FAILED";

    const updated = await prisma.applicationRun.update({
      where: { id: run.id },
      data: {
        activeKey: null,
        mode: effectiveMode,
        atsType: outcome.atsType,
        status: normalizedStatus,
        currentStep: finalStep,
        stageHistory: JSON.stringify(history.slice(-100)),
        needsUserActionReason: null,
        stoppedFieldLabel: null,
        stoppedFieldType: null,
        stoppedFieldOptions: null,
        stoppedFieldStep: null,
        stoppedFieldContext: null,
        answers: JSON.stringify(mergedAnswers),
        confirmationNumber: outcome.confirmationNumber ?? null,
        confirmationUrl: outcome.confirmationUrl ?? null,
        screenshotPath: outcome.screenshotPath ?? run.screenshotPath ?? null,
        errorLog: normalizedStatus === "failed" ? (outcome.error ?? outcome.detail) : null,
        errorCode: normalizedStatus === "failed" ? classifyErrorCode(outcome.error ?? outcome.detail).errorCode : null,
        finishedAt: new Date(),
      },
    });

    const userJobStatus =
      normalizedStatus === "submitted"
        ? "SUBMITTED"
        : normalizedStatus === "filled"
          ? "READY_TO_APPLY"
          : "FAILED";

    await prisma.userJobState.upsert({
      where: { userId_jobId: { userId, jobId: job.id } },
      create: {
        userId,
        jobId: job.id,
        applicationStatus: userJobStatus,
      },
      update: {
        applicationStatus: userJobStatus,
      },
    });

    await logAudit({
      userId,
      jobId: job.id,
      actor: "application-agent",
      action: `application-run-${outcome.status}`,
      detail: outcome.detail,
      metadata: {
        runId: updated.id,
        atsType: outcome.atsType,
        submissionMethod: outcome.submissionMethod,
        confirmationNumber: outcome.confirmationNumber ?? null,
        fieldsInspected: outcome.fieldsInspected,
        fieldsResolved: outcome.fieldsResolved,
      },
    });

    return {
      runId: updated.id,
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      atsType: outcome.atsType,
      status: updated.status,
      matchScore: updated.matchScoreAtRun ?? job.matchResults[0]?.score ?? null,
      confirmationNumber: updated.confirmationNumber,
      stoppedFieldLabel: updated.stoppedFieldLabel,
      detail: outcome.detail,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addStage("FAILED", message);
    await prisma.applicationRun.update({
      where: { id: run.id },
      data: {
        activeKey: null,
        status: "failed",
        currentStep: "FAILED",
        stageHistory: JSON.stringify(history.slice(-100)),
        errorLog: message,
        errorCode: classifyErrorCode(message).errorCode,
        finishedAt: new Date(),
      },
    });
    await prisma.userJobState.upsert({
      where: { userId_jobId: { userId, jobId: job.id } },
      create: { userId, jobId: job.id, applicationStatus: "FAILED" },
      update: { applicationStatus: "FAILED" },
    });
    await logAudit({
      userId,
      jobId: job.id,
      actor: "application-agent",
      action: "application-run-failed",
      detail: message,
      metadata: { runId: run.id },
    }).catch(() => undefined);

    return {
      runId: run.id,
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      atsType: run.atsType,
      status: "failed",
      matchScore: run.matchScoreAtRun ?? job.matchResults[0]?.score ?? null,
      confirmationNumber: null,
      stoppedFieldLabel: null,
      detail: message,
    };
  }
}

export async function prepareAndApplyForJob(
  jobId: string,
  userId: string,
  options: { mode?: AutopilotMode; gmailAccessToken?: string | null } = {},
): Promise<AutopilotRunOutcome> {
  const lockKey = `${userId}:${jobId}`;
  const inflight = inflightJobRunsMap();
  const existingPromise = inflight.get(lockKey);
  if (existingPromise) {
    return existingPromise;
  }
  const runPromise = prepareAndApplyForJobInternal(jobId, userId, options).finally(() => {
    inflight.delete(lockKey);
  });
  inflight.set(lockKey, runPromise);
  return runPromise;
}

async function prepareAndApplyForJobInternal(
  jobId: string,
  userId: string,
  options: { mode?: AutopilotMode; gmailAccessToken?: string | null } = {},
): Promise<AutopilotRunOutcome> {
  await ensureStarterProfile(userId);

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      matchResults: { where: { userId }, orderBy: { createdAt: "desc" }, take: 1 },
      generatedDocuments: { where: { userId }, orderBy: { createdAt: "desc" } },
      applicationRuns: { where: { userId }, orderBy: { createdAt: "desc" } },
    },
  });

  if (!job) {
    throw new Error("Job not found.");
  }

  const availability = canonicalAvailability(job.verificationStatus);
  if (availability === AVAILABILITY.SECURITY_BLOCKED) {
    throw new Error("This posting is quarantined/security-blocked and will not be applied to.");
  }
  if (availability === AVAILABILITY.CLOSED_CONFIRMED) {
    throw new Error("This posting is confirmed closed.");
  }
  if (!isActiveAvailability(job.verificationStatus)) {
    throw new Error("This posting is not currently active.");
  }

  const existingSubmitted = job.applicationRuns.find((r) => r.status === "submitted");
  if (existingSubmitted) {
    return {
      runId: existingSubmitted.id,
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      atsType: existingSubmitted.atsType,
      status: existingSubmitted.status,
      matchScore: existingSubmitted.matchScoreAtRun,
      confirmationNumber: existingSubmitted.confirmationNumber,
      stoppedFieldLabel: null,
      detail: "Application already submitted for this role.",
    };
  }

  // Resolve aggregator links (LinkedIn/Indeed/Intern-List/etc.) to direct official ATS URLs first
  const initialCandidateUrl = job.officialApplyUrl ?? job.url ?? job.officialJobUrl ?? job.sourceUrl;
  if (job.resolutionStatus !== "RESOLVED" || isAggregatorUrl(initialCandidateUrl)) {
    const resolved = await resolveAggregatorJobToOfficialAts(job.id);
    if (resolved.resolved && resolved.url) {
      job.officialApplicationUrl = resolved.url;
      job.officialApplyUrl = resolved.url;
      job.url = resolved.url;
      job.resolutionStatus = "RESOLVED";
      if (resolved.atsType) {
        job.atsType = resolved.atsType;
      }
    }
  }

  // Hydrate missing job description on demand from its official URL before matching
  if ((job.description ?? "").trim().length < 80) {
    const rawUrl = job.officialApplyUrl ?? job.url ?? job.officialJobUrl;
    if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
      try {
        const res = await fetch(rawUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) {
          const text = stripTagsToText(await res.text());
          if (text.length >= 120) {
            const clipped = text.slice(0, 12_000);
            await prisma.job.update({ where: { id: job.id }, data: { description: clipped } });
            job.description = clipped;
          }
        }
      } catch {
        // Non-fatal: downstream check gives a clean 400 message if still thin
      }
    }
  }

  // Synthesize usable description if external URL lacked plain text
  if (!hasUsableJobDescription(job)) {
    const fallbackDescription = buildEffectiveMatchDescription(job);
    await prisma.job.update({
      where: { id: job.id },
      data: { description: fallbackDescription },
    }).catch(() => undefined);
    job.description = fallbackDescription;
  }

  // Ensure MatchResult exists
  let latestMatch: (typeof job.matchResults)[number] | undefined = job.matchResults[0];
  if (!latestMatch) {
    try {
      const matched = await runMatchForJob(job.id, { userId, origin: "INITIAL_AUTO" });
      latestMatch = (await prisma.matchResult.findUnique({ where: { id: matched.id } })) ?? undefined;
    } catch {
      const immediate = await scoreSingleJobImmediate(job.id, userId, "INITIAL_AUTO");
      latestMatch = (await prisma.matchResult.findUnique({ where: { id: immediate.id } })) ?? undefined;
    }
  }

  if (latestMatch && latestMatch.eligibility === "Fail") {
    throw new Error("AI matching flagged this role as an explicit eligibility mismatch.");
  }

  // Ensure tailored Resume + Cover Letter PDFs exist & pass QA cleanly without manual halts
  let docs = job.generatedDocuments;
  let usableResume = docs.find((d) => isUsableResume(d));
  let coverLetter = docs.find(
    (d) => d.type === "coverLetter" && d.qaStatus === "pass" && d.identityVerified,
  );

  if (!usableResume || !coverLetter) {
    await ensureCleanAutonomousDocuments(job.id, userId, { includeCoverLetter: true });
    docs = await prisma.generatedDocument.findMany({
      where: { jobId: job.id, userId },
      orderBy: { createdAt: "desc" },
    });
    usableResume = docs.find((d) => isUsableResume(d));
    coverLetter = docs.find(
      (d) => d.type === "coverLetter" && d.qaStatus === "pass" && d.identityVerified,
    );
  }

  if (!usableResume) {
    throw new Error("Unable to generate a QA-approved resume for this posting.");
  }

  const mode: AutopilotMode = options.mode ?? "auto_submit";
  const officialApplyUrl = job.officialApplicationUrl ?? job.officialApplyUrl ?? job.url ?? job.officialJobUrl ?? job.sourceUrl;
  if (!officialApplyUrl) {
    throw new Error("This posting has no usable official application URL.");
  }
  if (isAggregatorUrl(officialApplyUrl)) {
    throw new Error(
      `This posting still points to ${new URL(officialApplyUrl).hostname} instead of the employer's direct ATS page. Try re-verifying or select a Verified ATS role.`,
    );
  }
  if (job.officialApplyUrl !== officialApplyUrl) {
    await prisma.job.update({ where: { id: job.id }, data: { officialApplyUrl } }).catch(() => undefined);
  }

  const resolvedAtsType = detectAtsFromText(officialApplyUrl).atsType as AtsType;

  // Reuse queued/paused/stale-running run, or upgrade an existing filled/failed packet when auto-submitting
  const reusableRun = job.applicationRuns.find(
    (r) =>
      r.status === "queued"
      || r.status === "needs_user_action"
      || (mode === "auto_submit" && r.status === "filled"),
  );
  let targetRunId = reusableRun?.id;
  const activeKey = applicationActiveKey(userId, job.id);

  if (
    reusableRun
    && (
      reusableRun.status === "filled"
      || reusableRun.atsType !== resolvedAtsType
      || reusableRun.resumeDocumentId !== usableResume.id
      || reusableRun.coverLetterDocumentId !== (coverLetter?.id ?? null)
    )
  ) {
    await clearStaleActiveKeys(activeKey, reusableRun.id);
    await prisma.applicationRun.update({
      where: { id: reusableRun.id },
      data: {
        activeKey,
        atsType: resolvedAtsType,
        resumeDocumentId: usableResume.id,
        coverLetterDocumentId: coverLetter?.id ?? null,
        attemptNumber: (reusableRun.attemptNumber ?? 1) + 1,
        finishedAt: null,
      },
    });
  }

  if (!targetRunId) {
    // Unconditionally clear ANY stale activeKey collision before creating a new run
    await clearStaleActiveKeys(activeKey);

    const atsType = detectAtsFromText(officialApplyUrl).atsType as AtsType;
    const completeness = jobDescriptionCompleteness(job);
    const strategyReason = `${documentStrategyReason("EXISTING_APPROVED_DOCUMENT", completeness)} (${strategyFromTailoringStatus(usableResume.tailoringStatus)})`;

    const created = await prisma.applicationRun.create({
      data: {
        userId,
        activeKey,
        jobId: job.id,
        mode,
        atsType,
        status: "queued",
        currentStep: "QUEUED",
        stageHistory: JSON.stringify([
          {
            stage: "QUEUED",
            at: new Date().toISOString(),
            detail: `Autonomous pipeline matched score=${latestMatch?.score ?? "N/A"} and tailored documents; starting ATS inspection.`,
          },
        ]),
        resumeDocumentId: usableResume.id,
        coverLetterDocumentId: coverLetter?.id ?? null,
        documentStrategy: "EXISTING_APPROVED_DOCUMENT",
        documentStrategyReason: strategyReason,
        jobDescriptionCompleteness: completeness,
        matchScoreAtRun: latestMatch?.score ?? null,
      },
    });
    targetRunId = created.id;
  }

  return executeApplicationRunNow(targetRunId, userId, {
    mode,
    gmailAccessToken: options.gmailAccessToken ?? null,
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) break;
        try {
          const value = await worker(items[index], index);
          results[index] = { status: "fulfilled", value };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

function stripTagsToText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function hydrateMissingJobDescriptions(limit = 25): Promise<number> {
  const thinJobs = await prisma.job.findMany({
    where: { activeFeed: true },
    orderBy: [{ sourcePostedAt: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true,
      description: true,
      officialApplyUrl: true,
      url: true,
      atsType: true,
      atsTenant: true,
    },
  });

  const needsHydration = thinJobs
    .filter((j) => (j.description ?? "").trim().length < 80)
    .slice(0, limit);
  if (needsHydration.length === 0) return 0;

  let hydrated = 0;
  await mapWithConcurrency(needsHydration, 5, async (job) => {
    const rawUrl = job.officialApplyUrl ?? job.url;
    if (!rawUrl || rawUrl.startsWith("/")) return;
    try {
      const parsed = new URL(rawUrl);
      let descriptionText = "";

      const ghMatch = parsed.pathname.match(/\/([a-z0-9_-]+)\/jobs\/([0-9]+)/i);
      const ghJid = parsed.searchParams.get("gh_jid");
      const ghBoard = (ghMatch && ghMatch[1] !== "embed" ? ghMatch[1] : null)
        ?? parsed.searchParams.get("for")
        ?? (job.atsType === "greenhouse" ? job.atsTenant : null);
      const ghId = ghMatch?.[2] ?? ghJid;

      if (ghBoard && ghId) {
        const res = await fetch(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ghBoard)}/jobs/${encodeURIComponent(ghId)}`,
          { signal: AbortSignal.timeout(4_500) },
        ).catch(() => null);
        if (res?.ok) {
          const data = (await res.json().catch(() => null)) as { content?: string } | null;
          if (data?.content) descriptionText = stripTagsToText(data.content);
        }
      } else if (/(?:^|\.)lever\.co$/i.test(parsed.hostname)) {
        const segs = parsed.pathname.split("/").filter(Boolean);
        if (segs.length >= 2) {
          const res = await fetch(
            `https://api.lever.co/v0/postings/${encodeURIComponent(segs[0])}/${encodeURIComponent(segs[1])}`,
            { signal: AbortSignal.timeout(4_500) },
          ).catch(() => null);
          if (res?.ok) {
            const data = (await res.json().catch(() => null)) as { descriptionPlain?: string; description?: string } | null;
            descriptionText = data?.descriptionPlain?.trim() || stripTagsToText(data?.description ?? "");
          }
        }
      }

      if (descriptionText.length >= 80) {
        await prisma.job.update({
          where: { id: job.id },
          data: { description: descriptionText },
        });
        hydrated += 1;
      }
    } catch {
      // Keep hydration best-effort and non-fatal
    }
  });
  return hydrated;
}

function atsSubmissionPriority(atsType: string | null | undefined, url: string | null | undefined): number {
  if (isAggregatorUrl(url)) return 0;
  const normalized = (atsType ?? "").toLowerCase();
  const rawUrl = (url ?? "").toLowerCase();
  // Deprioritize WAF-blocked SmartRecruiters and interactive Microsoft Eightfold SSO in unattended cycles
  if (
    normalized === "smartrecruiters"
    || /smartrecruiters\.com|careers\.microsoft\.com|eightfold\.ai/.test(rawUrl)
  ) {
    return 0;
  }
  // Rippling has zero CAPTCHA and zero email OTP spam — highest direct-submit reliability
  if (/ats\.rippling\.com/.test(rawUrl)) {
    return 4;
  }
  // Greenhouse, Ashby, and Lever direct-submit forms
  if (
    normalized === "greenhouse"
    || normalized === "ashby"
    || normalized === "lever"
    || /greenhouse\.io|ashbyhq\.com|lever\.co/.test(rawUrl)
  ) {
    return 3;
  }
  return 1;
}

function eeInternshipRelevanceBoost(title: string | null | undefined, company: string | null | undefined): number {
  const hay = `${title ?? ""} ${company ?? ""}`.toLowerCase();
  let boost = 0;
  if (
    /\b(electrical|hardware|embedded|firmware|electronics|robotics|silicon|asic|fpga|serdes|analog|pcb|power|rf\b|controls|mechatronics|photonics|sensing|quantum|avionics|validation|test engineer|systems engineer)\b/.test(
      hay,
    )
  ) {
    boost += 30;
  }
  if (/\b2027\b|summer\s*2027/.test(hay)) {
    boost += 12;
  }
  return boost;
}

function runWasWaitingOnEmailOrSso(stageHistoryJson: string | null): boolean {
  const stages = parseStageList(stageHistoryJson);
  const last = stages[stages.length - 1]?.stage ?? "";
  return [
    "EMAIL_VERIFICATION_SENT",
    "PORTAL_VERIFICATION_EMAIL_SENT",
    "PORTAL_SSO_AUTH_REQUIRED",
    "PORTAL_ACCESS_BLOCKED",
  ].includes(last);
}

export async function runAutopilotCycle(
  userId: string,
  options: {
    maxApplications?: number;
    minScore?: number;
    discoverFresh?: boolean;
    mode?: AutopilotMode;
    gmailAccessToken?: string | null;
  } = {},
): Promise<AutopilotCycleSummary> {
  const cfg = await getAutopilotConfig(userId);
  const mode = options.mode ?? cfg.mode;
  const minScore = options.minScore ?? cfg.minScore;
  const maxApplications = Math.min(25, Math.max(1, options.maxApplications ?? cfg.maxPerCycle));
  const discoverFresh = options.discoverFresh ?? cfg.discoverFresh;

  await ensureWorkspaceBootstrapped(userId, { skipDiscovery: false });
  await recoverStaleRunningRuns(userId).catch(() => 0);

  let discovered = 0;
  let scored = 0;

  const activeCount = await prisma.job.count({ where: { activeFeed: true } });
  if (discoverFresh || activeCount < 5) {
    const cycle = await runLiveDiscoveryCycle({
      maxCompanies: 16,
      scoreUserId: userId,
      maxScoreCount: 25,
    });
    discovered += cycle.discovered;
    scored += cycle.scored;
  }

  await pruneStaleActiveJobs().catch(() => undefined);
  await hydrateMissingJobDescriptions(25).catch(() => 0);

  // Guarantee 100% of active jobs are scored before selecting top matches
  const bulkScored = await scoreAllActiveJobsImmediately(userId, { origin: "INITIAL_AUTO" });
  scored += bulkScored.scored;

  // Pick top active eligible jobs not yet applied/filled/running
  const candidateJobs = await prisma.job.findMany({
    where: { activeFeed: true },
    include: {
      matchResults: { where: { userId }, orderBy: { createdAt: "desc" }, take: 1 },
      applicationRuns: { where: { userId } },
      userStates: { where: { userId }, take: 1 },
    },
    orderBy: [{ sourcePostedAt: "desc" }, { createdAt: "desc" }],
    take: 500,
  });

  const eligible = candidateJobs
    .filter((job) => {
      if (!isActiveAvailability(job.verificationStatus)) return false;
      const url = job.officialApplicationUrl ?? job.officialApplyUrl ?? job.url ?? job.officialJobUrl;
      if (!url) return false;
      // Never auto-run WAF-blocked / interactive-SSO / aggregator roles in bulk cycles (prevents login-code email spam)
      if (atsSubmissionPriority(job.atsType, url) === 0) return false;
      const state = job.userStates[0];
      if (state?.hidden || ["SUBMITTED", "APPLIED"].includes(state?.applicationStatus ?? "")) return false;
      const hasExisting = job.applicationRuns.some((r) =>
        ["submitted", "filled", "running"].includes(r.status),
      );
      if (hasExisting) return false;
      const latestMatch = job.matchResults[0];
      if (latestMatch?.eligibility === "Fail") return false;
      const score = latestMatch?.score ?? state?.matchScore ?? 0;
      return score >= minScore;
    })
    .sort((a, b) => {
      const aPrio = atsSubmissionPriority(a.atsType, a.officialApplicationUrl ?? a.officialApplyUrl ?? a.url);
      const bPrio = atsSubmissionPriority(b.atsType, b.officialApplicationUrl ?? b.officialApplyUrl ?? b.url);
      if (aPrio !== bPrio) return bPrio - aPrio;
      const sa = (a.matchResults[0]?.score ?? a.userStates[0]?.matchScore ?? 0) + eeInternshipRelevanceBoost(a.title, a.company);
      const sb = (b.matchResults[0]?.score ?? b.userStates[0]?.matchScore ?? 0) + eeInternshipRelevanceBoost(b.title, b.company);
      return sb - sa;
    })
    .slice(0, maxApplications);

  const settledRuns = await mapWithConcurrency(eligible, 3, (job) =>
    prepareAndApplyForJob(job.id, userId, {
      mode,
      gmailAccessToken: options.gmailAccessToken ?? null,
    }),
  );

  const runs: AutopilotRunOutcome[] = settledRuns.map((res, idx) => {
    const job = eligible[idx];
    if (res.status === "fulfilled") return res.value;
    return {
      runId: "",
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      atsType: job.atsType ?? "unknown",
      status: "failed",
      matchScore: job.matchResults[0]?.score ?? null,
      confirmationNumber: null,
      stoppedFieldLabel: null,
      detail: res.reason instanceof Error ? res.reason.message : String(res.reason),
    };
  });

  const summary: AutopilotCycleSummary = {
    ranAt: new Date().toISOString(),
    mode,
    discovered,
    scored,
    attempted: runs.length,
    submitted: runs.filter((r) => r.status === "submitted").length,
    filled: runs.filter((r) => r.status === "filled").length,
    needsUserAction: 0,
    failed: runs.filter((r) => r.status === "failed").length,
    runs,
  };

  await writeUserSetting(userId, AUTOPILOT_SUMMARY_KEY, summary);
  await logAudit({
    userId,
    actor: "application-agent",
    action: "autopilot-cycle-completed",
    detail: `Autonomous cycle (${mode}): discovered ${discovered}, scored ${scored}, attempted ${runs.length} (${summary.submitted} submitted, ${summary.filled} prepared/filled).`,
    metadata: {
      discovered,
      scored,
      attempted: summary.attempted,
      submitted: summary.submitted,
      filled: summary.filled,
      needsUserAction: 0,
    },
  }).catch(() => undefined);

  return summary;
}

export async function retryPendingRuns(
  userId: string,
  options: { limit?: number; gmailAccessToken?: string | null } = {},
): Promise<AutopilotCycleSummary> {
  await recoverStaleRunningRuns(userId).catch(() => 0);
  const limit = Math.min(25, Math.max(1, options.limit ?? 15));
  const allRuns = await prisma.applicationRun.findMany({
    where: { userId },
    include: {
      job: {
        select: {
          id: true,
          title: true,
          company: true,
          atsType: true,
          officialApplicationUrl: true,
          officialApplyUrl: true,
          url: true,
          verificationStatus: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 250,
  });

  const submittedJobIds = new Set(allRuns.filter((r) => r.status === "submitted").map((r) => r.jobId));
  const seenJobIds = new Set<string>();
  const pending: typeof allRuns = [];

  for (const run of allRuns) {
    if (submittedJobIds.has(run.jobId) || seenJobIds.has(run.jobId)) continue;
    if (!["filled", "failed", "needs_user_action"].includes(run.status)) continue;
    if (!isActiveAvailability(run.job.verificationStatus)) continue;
    const url = run.job.officialApplicationUrl ?? run.job.officialApplyUrl ?? run.job.url;
    // Skip WAF-blocked SmartRecruiters / interactive Microsoft SSO in bulk retries
    if (atsSubmissionPriority(run.atsType ?? run.job.atsType, url) === 0) continue;
    // Prevent security-code email spam: do NOT retry runs awaiting an email verification code unless Gmail OAuth is connected!
    if (!options.gmailAccessToken && runWasWaitingOnEmailOrSso(run.stageHistory)) continue;
    seenJobIds.add(run.jobId);
    pending.push(run);
  }

  pending.sort((a, b) => {
    const aPrio = atsSubmissionPriority(a.atsType ?? a.job.atsType, a.job.officialApplicationUrl ?? a.job.officialApplyUrl ?? a.job.url);
    const bPrio = atsSubmissionPriority(b.atsType ?? b.job.atsType, b.job.officialApplicationUrl ?? b.job.officialApplyUrl ?? b.job.url);
    if (aPrio !== bPrio) return bPrio - aPrio;
    const sa = (a.matchScoreAtRun ?? 0) + eeInternshipRelevanceBoost(a.job.title, a.job.company);
    const sb = (b.matchScoreAtRun ?? 0) + eeInternshipRelevanceBoost(b.job.title, b.job.company);
    return sb - sa;
  });

  const batch = pending.slice(0, limit);
  const settled = await mapWithConcurrency(batch, 3, (run) =>
    prepareAndApplyForJob(run.jobId, userId, {
      mode: "auto_submit",
      gmailAccessToken: options.gmailAccessToken ?? null,
    }),
  );

  const runs: AutopilotRunOutcome[] = settled.map((res, idx) => {
    const item = batch[idx];
    if (res.status === "fulfilled") return res.value;
    return {
      runId: item.id,
      jobId: item.jobId,
      jobTitle: item.job.title,
      company: item.job.company,
      atsType: item.atsType ?? item.job.atsType ?? "unknown",
      status: "failed",
      matchScore: item.matchScoreAtRun ?? null,
      confirmationNumber: null,
      stoppedFieldLabel: null,
      detail: res.reason instanceof Error ? res.reason.message : String(res.reason),
    };
  });

  const summary: AutopilotCycleSummary = {
    ranAt: new Date().toISOString(),
    mode: "auto_submit",
    discovered: 0,
    scored: 0,
    attempted: runs.length,
    submitted: runs.filter((r) => r.status === "submitted").length,
    filled: runs.filter((r) => r.status === "filled").length,
    needsUserAction: 0,
    failed: runs.filter((r) => r.status === "failed").length,
    runs,
  };

  await writeUserSetting(userId, AUTOPILOT_SUMMARY_KEY, summary);
  return summary;
}
