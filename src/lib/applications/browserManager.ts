import { createHash } from "node:crypto";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import {
  applicationExtensionPath,
  createWorkerBrowserContext,
  type WorkerExtensionStatus,
} from "./browserProfile";

export type BrowserManagerHealth = {
  state: "healthy" | "unhealthy" | "restarting" | "stopped";
  reason: string | null;
  generation: number;
  extensionReady: boolean;
  extensionId: string | null;
  extensionFingerprint: string | null;
  openPages: number;
};

export class BrowserRestartFailedError extends Error {
  readonly code = "BROWSER_RESTART_FAILED";

  constructor(firstError: unknown, retryError: unknown) {
    const first = errorMessage(firstError);
    const retry = errorMessage(retryError);
    super(`The application browser could not be restarted.\nFirst new-page error: ${first}\nRetry error: ${retry}`);
    this.name = "BrowserRestartFailedError";
  }
}

type HealthListener = (health: BrowserManagerHealth) => void | Promise<void>;

/**
 * The one background worker owns exactly one BrowserManager. API routes never
 * import or instantiate it. A normal run gets a new Page; only an explicitly
 * paused run may retain its own Page for same-run Resume.
 */
export class BrowserManager {
  private context: BrowserContext | null = null;
  private contextClosed = true;
  private extension: WorkerExtensionStatus = {
    ready: false,
    id: null,
    path: applicationExtensionPath(),
  };
  private loadedExtensionFingerprint: string | null = null;
  private state: BrowserManagerHealth["state"] = "unhealthy";
  private unhealthyReason: string | null = "The worker-owned browser has not started.";
  private generation = 0;
  private pausedPages = new Map<string, Page>();
  private restartPromise: Promise<BrowserContext> | null = null;
  private testCloseBeforeNextPage = false;

  constructor(
    private readonly extensionApiToken: string,
    private readonly onHealth?: HealthListener,
  ) {
    if (process.env.APPLICATION_WORKER_OWNER !== "1") {
      throw new Error("BrowserManager may only be created by the background application worker.");
    }
  }

  snapshot(): BrowserManagerHealth {
    return {
      state: this.state,
      reason: this.unhealthyReason,
      generation: this.generation,
      extensionReady: this.extension.ready,
      extensionId: this.extension.id,
      extensionFingerprint: this.loadedExtensionFingerprint,
      openPages: this.safeOpenPageCount(),
    };
  }

  async ensureHealthy(reason = "before application run"): Promise<BrowserContext> {
    const fingerprint = await extensionFingerprint();
    if (this.loadedExtensionFingerprint && fingerprint !== this.loadedExtensionFingerprint) {
      await this.markUnhealthy("The extension package changed and Chromium must reload it.");
    }
    if (this.context && this.isContextHealthy()) return this.context;
    return this.restart(reason, fingerprint);
  }

  async acquireRunPage(runId: string, resumePausedRun: boolean): Promise<{ page: Page; reused: boolean }> {
    let context = await this.ensureHealthy(`before run ${runId}`);
    if (resumePausedRun) {
      const retained = this.pausedPages.get(runId);
      if (retained && !retained.isClosed() && this.isContextHealthy()) return { page: retained, reused: true };
      this.pausedPages.delete(runId);
    } else {
      await this.releaseRunPage(runId, false);
    }

    if (this.testCloseBeforeNextPage) {
      this.testCloseBeforeNextPage = false;
      await this.closeOwnedContext("Test hook closed the context immediately before newPage.");
      context = await this.ensureHealthy(`closed immediately before newPage for run ${runId}`);
    }

    try {
      const page = await context.newPage();
      await this.closeUnusedBlankPages(page);
      return { page, reused: false };
    } catch (firstError) {
      if (!isClosedContextError(firstError)) throw firstError;
      await this.markUnhealthy(`newPage reported a closed context: ${errorMessage(firstError)}`);
      try {
        context = await this.restart(`newPage recovery for run ${runId}`);
        const page = await context.newPage();
        await this.closeUnusedBlankPages(page);
        return { page, reused: false };
      } catch (retryError) {
        await this.markUnhealthy(`Browser restart failed: ${errorMessage(retryError)}`);
        throw new BrowserRestartFailedError(firstError, retryError);
      }
    }
  }

  retainRunPage(runId: string, page: Page): void {
    if (!page.isClosed() && this.isContextHealthy()) this.pausedPages.set(runId, page);
  }

  async releaseRunPage(runId: string, close = true): Promise<void> {
    const page = this.pausedPages.get(runId);
    this.pausedPages.delete(runId);
    if (close && page && !page.isClosed()) await page.close().catch(() => {});
  }

  async finishRunPage(runId: string, page: Page, keepOpen: boolean): Promise<void> {
    if (keepOpen && !page.isClosed() && this.isContextHealthy()) {
      this.pausedPages.set(runId, page);
      return;
    }
    this.pausedPages.delete(runId);
    if (!page.isClosed()) await page.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.state = "stopped";
    this.unhealthyReason = "The application worker is stopping.";
    const owned = this.context;
    this.clearReferences();
    if (owned) await owned.close().catch(() => {});
    await this.emitHealth();
  }

  async forceCloseForTest(reason = "BrowserManager test hook"): Promise<void> {
    if (process.env.APPLICATION_WORKER_TEST_ONLY !== "1") throw new Error("Browser test hooks are disabled.");
    await this.closeOwnedContext(reason);
  }

  closeImmediatelyBeforeNextPageForTest(): void {
    if (process.env.APPLICATION_WORKER_TEST_ONLY !== "1") throw new Error("Browser test hooks are disabled.");
    this.testCloseBeforeNextPage = true;
  }

  async simulateExtensionRebuildForTest(): Promise<void> {
    if (process.env.APPLICATION_WORKER_TEST_ONLY !== "1") throw new Error("Browser test hooks are disabled.");
    this.loadedExtensionFingerprint = "test-stale-extension-fingerprint";
    await this.emitHealth();
  }

  async completeLocalCaptchaForTest(runId: string): Promise<void> {
    if (process.env.APPLICATION_WORKER_TEST_ONLY !== "1") throw new Error("Browser test hooks are disabled.");
    const page = this.pausedPages.get(runId);
    if (!page || page.isClosed()) throw new Error("The local mock CAPTCHA page is not retained for this run.");

    const current = new URL(page.url());
    const configuredMockOrigin = process.env.MOCK_ATS_BASE_URL;
    let isConfiguredMockPage = false;
    if (configuredMockOrigin) {
      try {
        isConfiguredMockPage = current.origin === new URL(configuredMockOrigin).origin;
      } catch {
        isConfiguredMockPage = false;
      }
    }

    // This hook exists only for the isolated test suite. Require the exact mock
    // ATS origin issued by that suite rather than trusting an arbitrary localhost
    // page or a production URL. The mock server now serves fixtures directly at
    // /ashby-captcha.html instead of under /mock-ats/, so pathname matching was
    // both stale and weaker than verifying the configured origin.
    if (!isConfiguredMockPage || !["localhost", "127.0.0.1"].includes(current.hostname)) {
      throw new Error("CAPTCHA test completion is restricted to the configured local mock ATS server.");
    }
    await page.evaluate(() => {
      document.querySelectorAll(
        '[class*="captcha" i], [id*="captcha" i], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
      ).forEach((element) => element.remove());
    });
  }

  private isContextHealthy(): boolean {
    if (!this.context || this.contextClosed || this.state !== "healthy") return false;
    const browser = this.context.browser();
    if (browser && !browser.isConnected()) return false;
    try {
      this.context.pages();
      return true;
    } catch {
      return false;
    }
  }

  private async restart(reason: string, knownFingerprint?: string): Promise<BrowserContext> {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = this.performRestart(reason, knownFingerprint);
    try {
      return await this.restartPromise;
    } finally {
      this.restartPromise = null;
    }
  }

  private async performRestart(reason: string, knownFingerprint?: string): Promise<BrowserContext> {
    this.state = "restarting";
    this.unhealthyReason = reason;
    await this.emitHealth();
    const stale = this.context;
    this.clearReferences();
    if (stale) await stale.close().catch(() => {});

    try {
      const launched = await createWorkerBrowserContext(this.extensionApiToken);
      this.context = launched.context;
      this.contextClosed = false;
      this.extension = launched.extension;
      this.loadedExtensionFingerprint = knownFingerprint ?? await extensionFingerprint();
      this.generation += 1;
      this.bindLifecycleEvents(launched.context, this.generation);

      const probe = await launched.context.newPage();
      await probe.close();
      this.state = "healthy";
      this.unhealthyReason = null;
      await this.emitHealth();
      return launched.context;
    } catch (error) {
      this.clearReferences();
      this.state = "unhealthy";
      this.unhealthyReason = errorMessage(error);
      await this.emitHealth();
      throw error;
    }
  }

  private bindLifecycleEvents(context: BrowserContext, generation: number): void {
    context.on("close", () => {
      if (this.context === context && this.generation === generation) {
        void this.markUnhealthy("The worker-owned browser context closed.");
      }
    });
    const browser = context.browser();
    browser?.on("disconnected", () => {
      if (this.context === context && this.generation === generation) {
        void this.markUnhealthy("The worker-owned Chromium process disconnected.");
      }
    });
  }

  private async markUnhealthy(reason: string): Promise<void> {
    this.state = "unhealthy";
    this.unhealthyReason = reason;
    this.contextClosed = true;
    this.pausedPages.clear();
    this.extension = { ready: false, id: null, path: applicationExtensionPath() };
    await this.emitHealth();
  }

  private async closeOwnedContext(reason: string): Promise<void> {
    const owned = this.context;
    await this.markUnhealthy(reason);
    this.context = null;
    if (owned) await owned.close().catch(() => {});
  }

  private clearReferences(): void {
    this.context = null;
    this.contextClosed = true;
    this.pausedPages.clear();
    this.extension = { ready: false, id: null, path: applicationExtensionPath() };
  }

  private safeOpenPageCount(): number {
    try {
      return this.context?.pages().length ?? 0;
    } catch {
      return 0;
    }
  }

  private async closeUnusedBlankPages(keep: Page): Promise<void> {
    const context = this.context;
    if (!context) return;
    await Promise.all(context.pages().map(async (page) => {
      if (page === keep || page.isClosed() || page.url() !== "about:blank") return;
      await page.close().catch(() => {});
    }));
  }

  private async emitHealth(): Promise<void> {
    await this.onHealth?.(this.snapshot());
  }
}

async function extensionFingerprint(): Promise<string> {
  const root = applicationExtensionPath();
  const hash = createHash("sha256");
  for (const name of (await readdir(root)).sort()) {
    const file = path.join(root, name);
    const metadata = await stat(file).catch(() => null);
    if (!metadata?.isFile()) continue;
    hash.update(name);
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isClosedContextError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("target page, context or browser has been closed")
    || message.includes("browser has been closed")
    || message.includes("context closed")
    || message.includes("target closed");
}
