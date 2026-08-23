import "dotenv/config";
import { chromium, type Request as PlaywrightRequest } from "playwright";

/**
 * What data calls does an employer's own careers frontend make?
 *
 *   npx tsx scripts/observe-careers-network.ts <url> [--search="intern"] [--wait=8000]
 *                                              [--click="text=Load more"] [--pages=2]
 *
 * A client-rendered careers site still has to get its postings from somewhere.
 * Guessing that endpoint is forbidden and was already tried and rejected, so
 * this observes it instead: open the page the way a person would, let the
 * employer's OWN JavaScript run, and record the fetch/XHR calls it makes.
 *
 * This is observation of public traffic during ordinary navigation. It does
 * not bypass anything — no CAPTCHA solving, no bot-protection evasion, no
 * header spoofing beyond a normal browser user agent, no authenticated or
 * private endpoints. If the site answers with a verification wall, that is the
 * finding, and the answer is that the employer is blocked.
 *
 * Resource-bounded by construction: one Chromium, images/fonts/media blocked,
 * a short deadline, and the browser closed in a finally block.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BLOCKED_RESOURCES = new Set(["image", "font", "media", "stylesheet"]);

/** Third-party telemetry that is never the employer's job data. */
const NOISE = /google-analytics|googletagmanager|doubleclick|facebook|hotjar|segment|newrelic|datadog|optimizely|adobedtm|demdex|qualtrics|cookielaw|onetrust|launchdarkly|sentry|clarity\.ms|bing\.com|linkedin\.com\/px/i;

/** Does this look like it carries postings rather than page furniture? */
function looksLikeJobData(url: string): boolean {
  return /job|career|position|opening|requisition|vacanc|search|posting|talent/i.test(url);
}

type Capture = {
  url: string;
  method: string;
  resourceType: string;
  postData: string | null;
  requestHeaders: Record<string, string>;
  status: number | null;
  contentType: string | null;
  bytes: number;
  /** Top-level shape of the JSON response, when it is JSON. */
  shape: string | null;
  sample: string | null;
};

function describeShape(value: unknown, depth = 0): string {
  if (depth > 2) return "…";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${describeShape(value[0], depth + 1)} ×${value.length}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return "{}";
    const shown = keys.slice(0, 14);
    return `{${shown.join(", ")}${keys.length > shown.length ? ", …" : ""}}`;
  }
  return typeof value;
}

async function main() {
  const url = process.argv.find((value) => value.startsWith("http"));
  if (!url) {
    console.error('usage: observe-careers-network.ts <url> [--search="intern"] [--wait=8000] [--click="selector"]');
    process.exitCode = 1;
    return;
  }
  const search = process.argv.find((v) => v.startsWith("--search="))?.slice(9) ?? null;
  const clickTarget = process.argv.find((v) => v.startsWith("--click="))?.slice(8) ?? null;
  const dumpUrl = process.argv.find((v) => v.startsWith("--dump="))?.slice(7) ?? null;
  const settleMs = Number.parseInt(process.argv.find((v) => v.startsWith("--wait="))?.slice(7) ?? "9000", 10) || 9000;

  const captures: Capture[] = [];
  const seen = new Set<string>();

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 900 } });
    await context.route("**/*", (route) => {
      if (BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });

    const page = await context.newPage();

    page.on("response", async (response) => {
      const request: PlaywrightRequest = response.request();
      const type = request.resourceType();
      if (type !== "xhr" && type !== "fetch") return;
      const requestUrl = response.url();
      if (NOISE.test(requestUrl)) return;
      if (!looksLikeJobData(requestUrl)) return;
      const key = `${request.method()} ${requestUrl.split("?")[0]}`;
      if (seen.has(key)) return;
      seen.add(key);

      const contentType = response.headers()["content-type"] ?? null;
      let shape: string | null = null;
      let sample: string | null = null;
      let bytes = 0;
      try {
        const body = await response.text();
        bytes = body.length;
        if (contentType?.includes("json")) {
          const parsed = JSON.parse(body) as unknown;
          shape = describeShape(parsed);
          sample = dumpUrl && requestUrl.includes(dumpUrl) ? body.slice(0, 6000) : body.slice(0, 600);
        } else {
          sample = body.slice(0, 200);
        }
      } catch {
        // A body we cannot read is still worth reporting by URL alone.
      }

      captures.push({
        url: requestUrl,
        method: request.method(),
        resourceType: type,
        requestHeaders: Object.fromEntries(
          Object.entries(request.headers()).filter(([name]) => !/^(cookie|authorization|sec-|accept-encoding|connection|host|content-length)/i.test(name)),
        ),
        postData: (dumpUrl && requestUrl.includes(dumpUrl) ? request.postData() : request.postData()?.slice(0, 600)) ?? null,
        status: response.status(),
        contentType,
        bytes,
        shape,
        sample,
      });
    });

    console.log(`[observe] ${url}`);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
    console.log(`[observe] document status ${response?.status() ?? "no response"} -> ${page.url()}`);

    await page.waitForTimeout(settleMs);

    if (search) {
      // Ordinary use of the employer's own search box.
      const box = page
        .locator('input[type="search"], input[name*="search" i], input[placeholder*="search" i], input[id*="search" i]')
        .first();
      if (await box.count()) {
        await box.fill(search).catch(() => undefined);
        await box.press("Enter").catch(() => undefined);
        console.log(`[observe] searched for "${search}"`);
        await page.waitForTimeout(settleMs);
      } else {
        console.log("[observe] no search input found on this page");
      }
    }

    if (clickTarget) {
      const target = page.locator(clickTarget).first();
      if (await target.count()) {
        await target.click({ timeout: 10_000 }).catch(() => undefined);
        console.log(`[observe] clicked ${clickTarget}`);
        await page.waitForTimeout(settleMs);
      } else {
        console.log(`[observe] no element matched ${clickTarget}`);
      }
    }

    // Was this a verification wall rather than the careers site?
    const body = await page.locator("body").innerText().catch(() => "");
    if (/human verification|are you a robot|verify you are human|access denied|unusual traffic/i.test(body)) {
      console.log("[observe] BOT VERIFICATION WALL — stopping. No circumvention attempted.");
    }
    console.log(`[observe] page text bytes ${body.length}`);
  } finally {
    await browser.close().catch(() => undefined);
  }

  console.log(`\n=== employer-initiated data calls: ${captures.length} ===`);
  for (const capture of captures) {
    console.log(`\n${capture.method} ${capture.url}`);
    console.log(`  status ${capture.status}  type ${capture.contentType ?? "?"}  bytes ${capture.bytes}`);
    if (capture.postData) console.log(dumpUrl && capture.url.includes(dumpUrl) ? `  FULL BODY
${capture.postData}` : `  body   ${capture.postData}`);
    if (dumpUrl && capture.url.includes(dumpUrl)) {
      console.log("  REQUEST HEADERS");
      for (const [name, value] of Object.entries(capture.requestHeaders)) console.log(`    ${name}: ${value.slice(0, 160)}`);
    }
    if (capture.shape) console.log(`  shape  ${capture.shape}`);
    if (capture.sample) console.log(`  sample ${capture.sample.replace(/\s+/g, " ").slice(0, 500)}`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
