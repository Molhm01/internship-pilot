import path from "node:path";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright";

const extensionPath = path.resolve(process.cwd(), "extension", "dist");
const testRoot = path.resolve(process.cwd(), "data", "test-runs");
const fakeToken = "isolated-extension-smoke-token-0000000000000000";

const applicationHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Extension smoke application</title></head>
<body>
  <form id="application">
    <label for="name">Full Name*</label><input id="name" required>
    <label for="email">Email*</label><input id="email" type="email" required>
    <label for="resume">Resume/CV*</label><input id="resume" type="file" required>
    <button type="submit">Submit application</button>
  </form>
  <script>
    document.getElementById("application").addEventListener("submit", (event) => {
      event.preventDefault();
      document.body.dataset.submitClicked = "true";
    });
  </script>
</body></html>`;

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate an isolated HTTP port."));
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  await mkdir(testRoot, { recursive: true });
  const profile = await mkdtemp(path.join(testRoot, "extension-"));
  const server = createServer((request, response) => {
    if (request.url === "/api/extension/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, submitEnabled: false }));
      return;
    }
    if (request.url === "/api/extension/fill-plan" || request.url === "/api/extension/profile") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Expected isolated authentication rejection." }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(applicationHtml);
  });
  const port = await listen(server);
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const serviceWorker = context.serviceWorkers()[0]
      ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(serviceWorker.url()).hostname;
    await serviceWorker.evaluate(
      async ({ apiToken, backendBaseUrl }) => {
        const scope = globalThis as unknown as {
          chrome: { storage: { local: { set: (items: Record<string, string>) => Promise<void> } } };
        };
        await scope.chrome.storage.local.set({ apiToken, backendBaseUrl });
      },
      { apiToken: fakeToken, backendBaseUrl: `http://127.0.0.1:${port}` },
    );

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/application`, { waitUntil: "domcontentloaded" });
    const button = page.locator('[data-internship-pilot-action="autofill"]');
    await button.waitFor({ state: "visible", timeout: 15_000 });
    await button.click();
    await page.waitForFunction(() => {
      const state = document.querySelector('[data-internship-pilot-action="autofill"]')?.getAttribute("data-ip-state");
      return state === "error" || state === "backend_unreachable";
    });
    const submitted = await page.locator("body").getAttribute("data-submit-clicked");
    if (submitted === "true") throw new Error("Safety failure: the extension clicked Submit.");

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    if (!await popup.getByText("Internship Pilot", { exact: true }).first().isVisible()) {
      throw new Error("Extension popup did not render.");
    }
    console.log(`PASS: Manifest V3 service worker loaded (${extensionId}).`);
    console.log("PASS: required in-page autofill button injected on an isolated generic form.");
    console.log("PASS: rejected backend authentication produced no fill and never clicked Submit.");
    console.log("PASS: extension popup rendered.");
  } finally {
    await context.close();
    await closeServer(server);
    const resolved = path.resolve(profile);
    if (resolved.startsWith(testRoot) && path.basename(resolved).startsWith("extension-")) {
      await rm(resolved, { recursive: true, force: true });
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
