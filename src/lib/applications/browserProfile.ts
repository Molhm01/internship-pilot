import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { issueWorkerExtensionToken } from "./extensionAuth";
import { applicationExtensionPath, applicationProfilePath } from "./browserPaths";

export { applicationExtensionPath, applicationProfilePath };

let workerContext: BrowserContext | null = null;
let workerPage: Page | null = null;

export type WorkerExtensionStatus = {
  ready: boolean;
  id: string | null;
  path: string;
};

function workerBackendBaseUrl(): string {
  const port = process.env.PORT ?? process.env.INTERNSHIP_PILOT_PORT ?? "3000";
  return process.env.INTERNSHIP_PILOT_BASE_URL ?? `http://127.0.0.1:${port}`;
}

async function extensionAvailable(): Promise<boolean> {
  if (process.env.DISABLE_AUTOFILL_EXTENSION === "1") return false;
  try {
    await access(path.join(applicationExtensionPath(), "manifest.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed the loaded extension's storage with the local API token and backend
 * base URL so its in-page autofill button authenticates immediately, then
 * resolve the extension's service-worker id. Without the token every
 * fill-plan call would 401; without loading the extension the in-page button
 * would never appear. Never throws — a failure yields ready:false so the
 * fill step reports an explicit error instead of hanging.
 */
async function seedAndIdentifyExtension(context: BrowserContext, token: string): Promise<WorkerExtensionStatus> {
  const status: WorkerExtensionStatus = { ready: false, id: null, path: applicationExtensionPath() };
  try {
    const [existing] = context.serviceWorkers();
    const worker = existing ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    status.id = new URL(worker.url()).hostname;
    await worker.evaluate(
      async ({ apiToken, backendBaseUrl }: { apiToken: string; backendBaseUrl: string }) => {
        const scope = globalThis as unknown as {
          chrome: { storage: { local: { set: (items: Record<string, string>) => Promise<void> } } };
        };
        await scope.chrome.storage.local.set({ apiToken, backendBaseUrl });
      },
      { apiToken: token, backendBaseUrl: workerBackendBaseUrl() },
    );
    status.ready = true;
  } catch (error) {
    console.error(
      `Application worker: could not initialize the autofill extension (${error instanceof Error ? error.message : String(error)}). ` +
        "Autofill will report an explicit error instead of hanging.",
    );
  }
  return status;
}

/**
 * Open a FRESH persistent Chromium context with the Internship Pilot autofill
 * extension loaded unpacked, seed its token, and report the extension status.
 * Used by BrowserManager (which handles restart/health) and by the simpler
 * singleton entry point below. Not cached.
 */
export async function createWorkerBrowserContext(
  extensionApiToken: string,
): Promise<{ context: BrowserContext; extension: WorkerExtensionStatus }> {
  if (process.env.APPLICATION_WORKER_OWNER !== "1") {
    throw new Error("Persistent application browser access is restricted to the background application worker.");
  }
  const profilePath = applicationProfilePath();
  await mkdir(profilePath, { recursive: true });

  const hasExtension = await extensionAvailable();
  const distPath = applicationExtensionPath();
  if (!hasExtension && process.env.DISABLE_AUTOFILL_EXTENSION !== "1") {
    console.error(
      `Application worker: extension build not found at ${distPath}. Run "npm run extension:build". ` +
        "Autofill will report that the extension did not inject instead of hanging.",
    );
  }
  const extensionArgs = hasExtension
    ? [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`]
    : [];

  // Chrome extensions require a headed browser OR Chromium's NEW headless
  // (via the "chromium" channel). Fill To Submit wants a visible window
  // anyway; FORCE_HEADLESS=1 (tests/CI) uses new headless so the extension
  // still loads.
  const forceHeadless = process.env.FORCE_HEADLESS === "1";
  const context = await chromium.launchPersistentContext(profilePath, {
    ...(forceHeadless ? { channel: "chromium", headless: true } : { headless: false }),
    viewport: { width: 1280, height: 900 },
    args: extensionArgs,
  });

  const extension = hasExtension
    ? await seedAndIdentifyExtension(context, extensionApiToken)
    : { ready: false, id: null, path: distPath };
  return { context, extension };
}

/**
 * The daemon's simple singleton entry point (the current worker uses this).
 * Loads the extension via createWorkerBrowserContext and caches the context.
 */
export async function launchWorkerBrowserContext(userId: string): Promise<BrowserContext> {
  if (workerContext) return workerContext;
  // The worker acts for one user, so it carries that user's own extension
  // token. There is no installation-wide credential any more, and a browser
  // launched without an owner could not be answered by the extension API.
  const token = await issueWorkerExtensionToken(userId);
  const { context } = await createWorkerBrowserContext(token);
  workerContext = context;
  return workerContext;
}

/**
 * Returns the one page owned by the application worker. Chromium creates an
 * initial about:blank page for a persistent context; reusing it avoids the
 * blank-tab leak that occurred when every run called context.newPage().
 */
export async function getWorkerApplicationPage(context: BrowserContext): Promise<Page> {
  if (process.env.APPLICATION_WORKER_OWNER !== "1") throw new Error("Application page access is restricted to the background worker.");
  const openPages = context.pages().filter((page) => !page.isClosed());
  if (!workerPage || workerPage.isClosed()) workerPage = openPages[0] ?? await context.newPage();
  for (const page of openPages) {
    if (page !== workerPage) await page.close().catch(() => {});
  }
  return workerPage;
}

/** Closes only the Playwright context this worker launched, never normal Chrome. */
export async function closeWorkerBrowserContext(): Promise<void> {
  const owned = workerContext;
  workerContext = null;
  workerPage = null;
  if (owned) await owned.close().catch(() => {});
}
