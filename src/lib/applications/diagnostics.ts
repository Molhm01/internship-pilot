import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { prisma } from "@/lib/db";
import { isCloudRuntime, LOCAL_ONLY_FEATURES } from "@/lib/runtime/deployment";
import { getApplicationSettings } from "./settings";
import { ATS_CAPABILITIES } from "./adapters";
import { applicationExtensionPath, applicationProfilePath } from "./browserPaths";
import { fetchWorkerHealth, isProcessRunning, readWorkerLock } from "./workerLock";
import { checkOllamaVisionHealth, OLLAMA_VISION_MODEL } from "@/lib/ollama";

function friendlyAgentError(technical: string | null): string | null {
  if (!technical) return null;
  const zod = readableLegacyZodError(technical);
  if (zod) return `Structured model output was invalid: ${zod}`;
  if (/launchPersistentContext|profile is already in use|existing browser session/i.test(technical)) {
    return "The application browser profile was busy. The single background worker owns and retries browser work now.";
  }
  if (/BROWSER_RESTART_FAILED|Target page, context or browser has been closed|browser.*disconnected/i.test(technical)) {
    return "The worker-owned application browser closed and could not be restarted for this run.";
  }
  if (/Ollama|Vision model request failed/i.test(technical)) {
    return "The local vision request failed. DOM-first filling can continue, and the same failed run can be retried after the vision preflight passes.";
  }
  if (/timeout/i.test(technical)) return "The application page took too long to respond.";
  return technical.split(/\r?\n/, 1)[0] || "The application worker stopped unexpectedly.";
}

function readableLegacyZodError(technical: string): string | null {
  if (!technical.includes("ZodError:")) return null;
  const start = technical.indexOf("[");
  const end = technical.indexOf("\n]", start);
  if (start < 0 || end < 0) return "Zod validation failed; open Show details for every field issue.";
  try {
    const issues = JSON.parse(technical.slice(start, end + 2)) as Array<{ path?: Array<string | number>; expected?: string; message?: string }>;
    return issues.map((issue) => {
      const path = issue.path?.length ? issue.path.join(".") : "(root)";
      const received = /received\s+([^\s]+)/i.exec(issue.message ?? "")?.[1] ?? "unknown";
      return `${path} expected ${issue.expected ?? "valid value"}, received ${received}`;
    }).join("; ");
  } catch {
    return "Zod validation failed; open Show details for every field issue.";
  }
}

function detailedAgentError(technical: string | null): string | null {
  if (!technical) return null;
  const readable = readableLegacyZodError(technical);
  return readable ? `Readable field-level validation errors:\n${readable}\n\nComplete technical details:\n${technical}` : technical;
}

/**
 * Playwright is a ~300 MB local dependency whose only purpose here is to name
 * the Chromium binary on this machine. Importing it lazily keeps it out of a
 * deployed function bundle entirely, and in a cloud runtime the question is
 * already answered: the browser that fills applications is the user's, not
 * this server's.
 */
async function chromiumExecutablePath(): Promise<string> {
  const { chromium } = await import("playwright");
  return chromium.executablePath();
}

export async function getAgentDiagnostics() {
  const cloud = isCloudRuntime();
  const visionInstallation = await checkOllamaVisionHealth();
  let chromiumInstalled = false;
  let profileWritable = false;
  let extensionPackageBuilt = false;
  let browserError: string | null = cloud ? LOCAL_ONLY_FEATURES.playwright : null;
  try {
    if (cloud) throw new Error(LOCAL_ONLY_FEATURES.playwright);
    await access(await chromiumExecutablePath(), constants.R_OK);
    chromiumInstalled = true;
  } catch (error) {
    browserError ??= error instanceof Error ? error.stack ?? error.message : String(error);
  }
  try {
    await mkdir(applicationProfilePath(), { recursive: true });
    await access(applicationProfilePath(), constants.R_OK | constants.W_OK);
    profileWritable = true;
  } catch (error) {
    browserError ??= error instanceof Error ? error.stack ?? error.message : String(error);
  }
  try {
    await Promise.all([
      "manifest.json",
      "background.js",
      "page-reader.js",
      "content.js",
      "content.css",
      "popup.html",
      "popup.css",
      "popup.js",
    ].map((filename) => access(
      path.join(/* turbopackIgnore: true */ applicationExtensionPath(), filename),
      constants.R_OK,
    )));
    extensionPackageBuilt = true;
  } catch (error) {
    browserError ??= error instanceof Error ? error.stack ?? error.message : String(error);
  }

  const lock = await readWorkerLock();
  const processAlive = Boolean(lock && isProcessRunning(lock.pid));
  const heartbeatFresh = Boolean(lock && Date.now() - new Date(lock.heartbeatAt).getTime() < 10_000);
  const workerHealth = lock && processAlive ? await fetchWorkerHealth(lock) : null;
  const workerRunning = Boolean(workerHealth && heartbeatFresh);
  const profileOwned = Boolean(
    workerRunning
    && workerHealth?.browserReady
    && workerHealth?.browserHealth === "healthy"
    && path.resolve(/* turbopackIgnore: true */ workerHealth.profilePath) === applicationProfilePath()
  );
  const extensionLoaded = Boolean(workerRunning && workerHealth?.extensionReady && workerHealth.extensionId);

  const [profile, resumeAvailable, resumeDoc, coverDoc, lastRun, settings, greenhouseInspectionSetting, leverInspectionSetting, ollamaVisionPreflightSetting, activeGroups] = await Promise.all([
    prisma.applicationProfile.findUnique({ where: { id: "default" } }),
    access(
      path.join(/* turbopackIgnore: true */ process.cwd(), "templates", "master_resume_reference.pdf"),
      constants.R_OK,
    ).then(() => true).catch(() => false),
    prisma.generatedDocument.findFirst({ where: { type: "resume", qaStatus: "pass" }, orderBy: { createdAt: "desc" } }),
    prisma.generatedDocument.findFirst({ where: { type: "coverLetter", qaStatus: "pass" }, orderBy: { createdAt: "desc" } }),
    prisma.applicationRun.findFirst({ orderBy: { updatedAt: "desc" } }),
    getApplicationSettings(),
    prisma.appSetting.findUnique({ where: { key: "greenhouseRealInspection" } }),
    prisma.appSetting.findUnique({ where: { key: "leverRealInspection" } }),
    prisma.appSetting.findUnique({ where: { key: "ollamaVisionPreflight" } }),
    prisma.applicationRun.groupBy({
      by: ["jobId"],
      where: { status: { in: ["queued", "running", "needs_user_action"] } },
      _count: { _all: true },
    }),
  ]);
  const duplicateProtection = activeGroups.every((group) => group._count._all <= 1);
  const candidateProfileComplete = Boolean(profile?.fullName && profile.email && profile.phone && profile.school);
  const technicalError = lastRun?.errorLog ?? browserError;
  let greenhouseRealInspection: unknown = null;
  let leverRealInspection: unknown = null;
  let ollamaVisionPreflight: {
    pass?: boolean;
    testedAt?: string;
    ollamaVersion?: string | null;
    model?: string;
    endpoint?: string;
    image?: { width?: number; height?: number; byteSize?: number; format?: string; quality?: number };
    tests?: Record<string, { httpStatus?: number | null; validContent?: boolean; responseBody?: string }>;
  } | null = null;
  try {
    greenhouseRealInspection = greenhouseInspectionSetting ? JSON.parse(greenhouseInspectionSetting.value) : null;
  } catch {
    greenhouseRealInspection = { pass: false, error: "Stored Greenhouse inspection report is invalid JSON." };
  }
  try {
    leverRealInspection = leverInspectionSetting ? JSON.parse(leverInspectionSetting.value) : null;
  } catch {
    leverRealInspection = { pass: false, error: "Stored Lever inspection report is invalid JSON." };
  }
  try {
    ollamaVisionPreflight = ollamaVisionPreflightSetting
      ? JSON.parse(ollamaVisionPreflightSetting.value) as typeof ollamaVisionPreflight
      : null;
  } catch {
    ollamaVisionPreflight = { pass: false };
  }
  const imageTest = ollamaVisionPreflight?.tests?.imageJson;
  const visionScreenshotPass = Boolean(
    visionInstallation.modelInstalled
    && ollamaVisionPreflight?.model === OLLAMA_VISION_MODEL
    && imageTest?.httpStatus === 200
    && imageTest.validContent === true,
  );
  const visionDetail = visionScreenshotPass
    ? `Real JPEG screenshot request passed with Ollama ${ollamaVisionPreflight?.ollamaVersion ?? "unknown"}, ${OLLAMA_VISION_MODEL}, HTTP 200; ${ollamaVisionPreflight?.image?.width ?? "?"}x${ollamaVisionPreflight?.image?.height ?? "?"}, ${ollamaVisionPreflight?.image?.byteSize ?? "?"} bytes.`
    : ollamaVisionPreflight
      ? `The latest real screenshot preflight did not return HTTP 200 with valid JSON content for ${OLLAMA_VISION_MODEL}.`
      : `Run npm run test:ollama-vision to perform a real screenshot request to ${OLLAMA_VISION_MODEL}.`;

  return {
    checks: {
      playwrightInstalled: { pass: true },
      chromiumInstalled: { pass: chromiumInstalled },
      browserCanLaunch: {
        pass: Boolean(workerHealth?.browserReady && workerHealth.browserHealth === "healthy"),
        detail: workerHealth
          ? `BrowserManager ${workerHealth.browserHealth}, generation ${workerHealth.browserGeneration}, ${workerHealth.browserOpenPages} open page(s)${workerHealth.browserHealthReason ? `: ${workerHealth.browserHealthReason}` : "."}`
          : "Reported by the profile-owning worker; diagnostics does not launch a competing browser.",
      },
      persistentBrowserProfileWritable: { pass: profileWritable },
      extensionPackageBuilt: { pass: extensionPackageBuilt, detail: applicationExtensionPath() },
      extensionLoadedByWorker: {
        pass: extensionLoaded,
        detail: extensionLoaded ? `Manifest V3 extension ${workerHealth?.extensionId} is loaded in the worker-owned Chromium context.` : "The worker has not confirmed its extension service worker.",
      },
      candidateProfileComplete: { pass: candidateProfileComplete },
      masterResumeAvailable: { pass: resumeAvailable },
      tailoredResumeGenerated: { pass: Boolean(resumeDoc) },
      coverLetterGenerated: { pass: Boolean(coverDoc) },
      applicationQueueRunning: { pass: workerRunning, detail: workerRunning ? "Worker heartbeat and queue polling port are healthy." : "No fresh application-worker heartbeat was found." },
      backgroundWorkerRunning: { pass: workerRunning, detail: lock ? `PID ${lock.pid}, port ${lock.port}` : "Worker lock is missing." },
      browserProfileOwnedByOneWorker: { pass: profileOwned, detail: profileOwned ? `Exclusive owner PID ${lock?.pid}.` : "Exclusive browser ownership could not be confirmed." },
      duplicateRunProtection: { pass: duplicateProtection, detail: duplicateProtection ? "Unique active-run key is healthy; no duplicate active runs exist." : "Duplicate active runs require repair." },
      visionModelAvailable: { pass: visionScreenshotPass, detail: visionInstallation.modelInstalled ? visionDetail : visionInstallation.error ?? `Install a vision-capable Ollama model and set OLLAMA_VISION_MODEL.` },
    },
    mode: settings.mode,
    autoSubmitDisabled: true,
    lastAgentError: friendlyAgentError(technicalError),
    completeErrorStack: detailedAgentError(technicalError),
    lastFailureScreenshot: lastRun?.screenshotPath ?? null,
    currentApplicationStep: lastRun?.currentStep ?? null,
    lastRunId: lastRun?.id ?? null,
    adapterCapabilities: ATS_CAPABILITIES,
    greenhouseRealInspection,
    leverRealInspection,
    ollamaVisionPreflight,
  };
}
