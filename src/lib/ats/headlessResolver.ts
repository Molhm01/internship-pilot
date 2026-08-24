// Bounded headless fallback for career sites that refuse plain HTTP reads.
//
// Some vendors — iCIMS most notably — answer an automated GET with HTTP 405
// "Human Verification" while serving the same page normally to a browser. That
// is not a closed posting and must never be recorded as one, but it does mean
// the only way to read the PUBLIC job list is to render the page.
//
// This is deliberately the LAST resort, and deliberately expensive to reach:
//
//   * HTTP/API resolution is always tried first; a browser is launched only for
//     a candidate that has already failed it.
//   * At most ONE browser process exists at a time, process-wide, and at most
//     MAX_PAGES tabs inside it.
//   * The browser is launched per batch and closed in a finally block. Nothing
//     is kept warm between radar ticks — a permanently resident Chromium is
//     exactly the thing this must not become.
//   * Hard wall-clock budget for the whole batch, plus a per-page timeout.
//   * Images, fonts, media and stylesheets are blocked, which is most of the
//     memory and CPU a rendered page costs.
//   * A tenant that fails is put on a cooldown so the next tick does not pay
//     the same price again.
//
// It performs ordinary public navigation only: no login, no CAPTCHA solving,
// no fingerprint spoofing beyond a standard desktop user agent.

import type { AtsJob } from "@/lib/ats/types";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Never render more than this many pages in one batch. */
const MAX_PAGES = 6;
/** Pages rendered at the same time. Low on purpose: this runs on a workstation. */
const CONCURRENCY = 2;
/** Whole-batch budget. When it runs out the browser closes, resolved or not. */
const BATCH_BUDGET_MS = 60_000;
const PAGE_TIMEOUT_MS = 25_000;
/** How long a failing tenant is left alone before another render is attempted. */
const TENANT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

export type HeadlessRequest = {
  /** Stable key for cooldown accounting — normally "<atsType>:<tenant>". */
  tenantKey: string;
  /** Public list/search page to render. */
  url: string;
  companyName: string;
};

export type HeadlessOutcome = {
  tenantKey: string;
  jobs: AtsJob[];
  /** Set when this tenant was skipped or the render failed. */
  error: string | null;
};

const cooldownUntil = new Map<string, number>();
const renderCooldownUntil = new Map<string, number>();

/** Only one headless batch may run at a time, process-wide. */
let batchInFlight: Promise<HeadlessOutcome[]> | null = null;

export function isHeadlessTenantCoolingDown(tenantKey: string, now = Date.now()): boolean {
  const until = cooldownUntil.get(tenantKey);
  return until !== undefined && until > now;
}

export function markHeadlessTenantCooldown(tenantKey: string, now = Date.now()): void {
  cooldownUntil.set(tenantKey, now + TENANT_COOLDOWN_MS);
}

/** Test seam — cooldowns are process-local and must not leak between tests. */
export function resetHeadlessCooldowns(): void {
  cooldownUntil.clear();
  renderCooldownUntil.clear();
}

/**
 * Render one public careers page and hand back its POST-JAVASCRIPT HTML.
 *
 * This is the discovery-stage counterpart to resolveWithHeadlessBrowser: some
 * employers (ByteDance, New York Life, Freeform) ship a careers page whose
 * served HTML contains no ATS signature and no postings, because both only
 * exist after the page's own scripts run. Rendering once lets the SAME pure
 * detectors that handle every other employer see what a visitor sees.
 *
 * Deliberately returns raw HTML rather than parsed jobs: the caller already
 * owns the detection logic, and duplicating it inside the browser would mean
 * two implementations to keep honest.
 *
 * Cooldowns are keyed by hostname so a site that renders nothing useful is not
 * re-rendered on the next radar tick.
 */
export async function renderCareersPage(
  url: string,
): Promise<{ html: string; finalUrl: string } | null> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const now = Date.now();
  if ((renderCooldownUntil.get(host) ?? 0) > now) return null;
  // Reserve the cooldown up front so concurrent workers cannot each launch a
  // render for the same host before the first one finishes.
  renderCooldownUntil.set(host, now + TENANT_COOLDOWN_MS);

  while (batchInFlight) {
    try {
      await batchInFlight;
    } catch {
      break;
    }
  }

  const run = async (): Promise<{ html: string; finalUrl: string } | null> => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
    });
    try {
      const context = await browser.newContext({ userAgent: USER_AGENT });
      await context.route("**/*", (route) => {
        if (BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });
      if (!response || response.status() >= 400) return null;
      await page.waitForTimeout(3_000);
      return { html: await page.content(), finalUrl: page.url() };
    } finally {
      // Non-negotiable: the browser never outlives this call.
      await browser.close().catch(() => undefined);
    }
  };

  const pending = run();
  // Share the render-lock with the batch path so only one Chromium ever exists.
  batchInFlight = pending.then(() => []).catch(() => []);
  let rendered: { html: string; finalUrl: string } | null = null;
  try {
    rendered = await pending;
  } catch {
    rendered = null;
  } finally {
    batchInFlight = null;
  }

  // A useful render earns the host its cooldown back.
  if (rendered) renderCooldownUntil.delete(host);
  return rendered;
}

/**
 * Job links visible on a rendered public listing page.
 *
 * Runs inside the page, so it sees the DOM the vendor actually produced. Only
 * anchor text and href are read; nothing is clicked and nothing is submitted.
 */
function extractJobLinks(): { title: string; href: string; location: string | null }[] {
  const out: { title: string; href: string; location: string | null }[] = [];
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") ?? "";
    const title = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!title || title.length > 160) continue;
    if (!/\/jobs?\/|\/job\b|jobid|requisition/i.test(href)) continue;
    if (!/intern|co-?op/i.test(title)) continue;

    // A listing row usually carries its location as a sibling/parent line.
    const container = anchor.closest("li, tr, article, div");
    const containerText = (container?.textContent ?? "").replace(/\s+/g, " ").trim();
    const locationMatch = containerText.match(/\b([A-Z][A-Za-z.\- ]+,\s*[A-Z]{2})\b/);
    out.push({ title, href, location: locationMatch?.[1] ?? null });
    if (out.length >= 60) break;
  }
  return out;
}

async function renderOne(
  browser: import("playwright").Browser,
  request: HeadlessRequest,
): Promise<HeadlessOutcome> {
  const context = await browser.newContext({ userAgent: USER_AGENT, javaScriptEnabled: true });
  try {
    await context.route("**/*", (route) => {
      if (BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    const response = await page.goto(request.url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    if (!response || response.status() >= 400) {
      return {
        tenantKey: request.tenantKey,
        jobs: [],
        error: `Rendered page returned HTTP ${response?.status() ?? "no response"}.`,
      };
    }
    // Give client-side rendering a bounded moment; never wait on networkidle,
    // which analytics beacons can keep alive indefinitely.
    await page.waitForTimeout(2_500);

    const links = await page.evaluate(extractJobLinks);
    const baseUrl = page.url();
    const jobs: AtsJob[] = [];
    const seen = new Set<string>();
    for (const link of links) {
      let applyUrl: string;
      try {
        applyUrl = new URL(link.href, baseUrl).toString();
      } catch {
        continue;
      }
      if (seen.has(applyUrl)) continue;
      seen.add(applyUrl);
      jobs.push({
        sourceJobId: applyUrl,
        requisitionId: applyUrl.match(/\/jobs?\/(\d{3,})/)?.[1] ?? null,
        title: link.title,
        company: request.companyName,
        location: link.location,
        workplaceType: null,
        applyUrl,
        // Rendering a LIST page yields no job description. The posting is still
        // promoted; JD hydration fetches the detail page afterwards.
        description: "",
        postedAt: null,
        postedAtText: null,
      });
    }
    return { tenantKey: request.tenantKey, jobs, error: null };
  } catch (error) {
    return {
      tenantKey: request.tenantKey,
      jobs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function runBatch(requests: HeadlessRequest[]): Promise<HeadlessOutcome[]> {
  const { chromium } = await import("playwright");
  const startedAt = Date.now();
  const browser = await chromium.launch({
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
  });

  const results: HeadlessOutcome[] = [];
  try {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, requests.length) }, async () => {
      while (cursor < requests.length) {
        if (Date.now() - startedAt >= BATCH_BUDGET_MS) return;
        const request = requests[cursor++]!;
        const outcome = await renderOne(browser, request);
        if (outcome.error || outcome.jobs.length === 0) {
          markHeadlessTenantCooldown(outcome.tenantKey);
        }
        results.push(outcome);
      }
    });
    await Promise.all(workers);
  } finally {
    // Non-negotiable: the browser never outlives the batch.
    await browser.close().catch(() => undefined);
  }
  return results;
}

/**
 * Render a bounded set of public career pages and return the postings on them.
 *
 * Returns an empty list — never throws — when Playwright is unavailable, so a
 * machine without a browser installed simply falls back to "unresolved, retry
 * later" instead of failing the whole radar tick.
 */
export async function resolveWithHeadlessBrowser(
  requests: HeadlessRequest[],
): Promise<HeadlessOutcome[]> {
  const now = Date.now();
  const eligible: HeadlessRequest[] = [];
  const skipped: HeadlessOutcome[] = [];
  const seenTenants = new Set<string>();

  for (const request of requests) {
    if (seenTenants.has(request.tenantKey)) continue;
    seenTenants.add(request.tenantKey);
    if (isHeadlessTenantCoolingDown(request.tenantKey, now)) {
      skipped.push({
        tenantKey: request.tenantKey,
        jobs: [],
        error: "Tenant is in headless-render cooldown after a recent failure.",
      });
      continue;
    }
    eligible.push(request);
    if (eligible.length >= MAX_PAGES) break;
  }

  if (eligible.length === 0) return skipped;

  // Serialize batches process-wide: two radar ticks overlapping must not put
  // two Chromium processes on the machine at once.
  while (batchInFlight) {
    try {
      await batchInFlight;
    } catch {
      break;
    }
  }

  const run = runBatch(eligible).catch((error): HeadlessOutcome[] =>
    eligible.map((request) => {
      markHeadlessTenantCooldown(request.tenantKey);
      return {
        tenantKey: request.tenantKey,
        jobs: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }),
  );
  batchInFlight = run;
  try {
    return [...skipped, ...(await run)];
  } finally {
    batchInFlight = null;
  }
}
