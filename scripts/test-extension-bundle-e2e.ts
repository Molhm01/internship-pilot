import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

let failures = 0;
function check(condition: unknown, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { failures += 1; console.error(`  FAIL: ${message}`); }
}

const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url === "/job") {
    res.end("<!doctype html><title>Internship Pilot fixture</title><main><h1>Software Engineering Intern</h1></main>");
    return;
  }
  res.end(`<!doctype html><title>Employer application</title><main id="application"><form id="step1">
    <h1>Application — step 1</h1>
    <label for="first">First name *</label><input id="first" required>
    <button id="continue" type="button">Continue</button>
  </form></main><script>
    window.submitClicks = 0;
    document.querySelector('#continue').addEventListener('click', () => {
      history.pushState({}, '', '/apply/step-2');
      document.querySelector('#application').innerHTML = '<form id="step2"><h1>Application — step 2</h1>' +
        '<label for="email">Email *</label><input id="email" type="email" required>' +
        '<label for="resume">Resume *</label><input id="resume" type="file" required>' +
        '<label for="cover">Cover letter *</label><input id="cover" type="file" required>' +
        '<button id="submit" type="submit">Submit Application</button></form>';
      document.querySelector('#step2').addEventListener('submit', (event) => { event.preventDefault(); window.submitClicks += 1; });
    });
  </script>`);
});

async function main() {
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address();
      if (!value || typeof value === "string") reject(new Error("No fixture port."));
      else resolve({ port: value.port });
    });
  });
  const root = path.resolve("data/test-runs");
  const profile = await mkdtemp(path.join(root, "bundle-e2e-"));
  const base = `http://127.0.0.1:${address.port}`;
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${path.resolve("extension/dist")}`, `--load-extension=${path.resolve("extension/dist")}`],
  });
  try {
    const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = context.pages()[0] ?? await context.newPage();
    await page.addInitScript(() => {
      (globalThis as unknown as { __name?: (value: unknown) => unknown }).__name = (value) => value;
    });
    await page.goto(`${base}/job`);
    const probe = await page.evaluate(() => new Promise<boolean>((resolve) => {
      const requestId = `probe-${Date.now()}`;
      const timer = setTimeout(() => resolve(false), 5_000);
      const listener = (event: MessageEvent) => {
        if (event.data?.channel !== "internship-agent:bridge-available" || event.data?.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener("message", listener); resolve(true);
      };
      window.addEventListener("message", listener);
      window.postMessage({ channel: "internship-agent:bridge-probe", requestId }, location.origin);
    }));
    check(probe, "website bridge is reachable");

    const fingerprint = "b".repeat(64);
    const transferred = await page.evaluate(({ baseUrl, fp }) => new Promise<Record<string, unknown>>((resolve) => {
      const requestId = `offer-${Date.now()}`;
      const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), 10_000);
      const listener = (event: MessageEvent) => {
        if (event.data?.channel !== "internship-agent:bundle-result" || event.data?.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener("message", listener); resolve(event.data.result);
      };
      window.addEventListener("message", listener);
      window.postMessage({
        channel: "internship-agent:bundle-offer", requestId,
        bundle: {
          bundleVersion: 3,
          websiteJobId: "job-bundle-e2e",
          company: "Fixture Employer",
          jobTitle: "Software Engineering Intern",
          jobDescription: "Build accessible form workflows.",
          officialApplicationUrl: `${baseUrl}/apply`,
          documentFingerprint: fp,
          documentsReused: false,
          createdAt: new Date().toISOString(),
          profile: {
            version: 3,
            personal: { legalFirstName: "Riley", legalLastName: "Fixture", email: "riley@example.com", address: {} },
            education: [], projects: [], experience: [], skills: { technical: [], programmingLanguages: [] }, eligibility: {}, sensitivePolicies: [],
          },
          approvedAnswers: [], answerContext: { neverClaimFacts: [] },
          documents: [
            { documentId: "resume-1", websiteJobId: "job-bundle-e2e", kind: "resume", filename: "Resume-Fixture.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0xLjQK", byteLength: 9, generatedAt: new Date().toISOString(), documentFingerprint: fp, qaStatus: "pass", identityVerified: true },
            { documentId: "cover-1", websiteJobId: "job-bundle-e2e", kind: "cover_letter", filename: "Cover-Letter-Fixture.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0xLjQK", byteLength: 9, generatedAt: new Date().toISOString(), documentFingerprint: fp, qaStatus: "pass", identityVerified: true },
          ],
        },
      }, location.origin);
    }), { baseUrl: base, fp: fingerprint });
    check(transferred.ok === true && Array.isArray(transferred.storedDocuments), "one authoritative bundle is acknowledged and stored before navigation");

    await page.goto(`${base}/apply`);
    await page.waitForFunction(() => document.querySelector('[data-internship-pilot-action="autofill"]')?.getAttribute("data-ip-state") === "filled", null, { timeout: 20_000 });
    const result = await page.evaluate(() => ({
      url: location.pathname,
      first: (document.querySelector("#first") as HTMLInputElement | null)?.value,
      email: (document.querySelector("#email") as HTMLInputElement | null)?.value,
      resume: (document.querySelector("#resume") as HTMLInputElement | null)?.files?.[0]?.name,
      cover: (document.querySelector("#cover") as HTMLInputElement | null)?.files?.[0]?.name,
      submitClicks: (window as unknown as { submitClicks: number }).submitClicks,
      detail: document.querySelector('[data-internship-pilot-action="autofill"]')?.getAttribute("data-ip-detail"),
    }));
    check(result.url === "/apply/step-2", "verified Continue navigation advances to the next page");
    check(result.email === "riley@example.com", "the next page is rescanned and filled from the stored bundle");
    check(result.resume === "Resume-Fixture.pdf" && result.cover === "Cover-Letter-Fixture.pdf", "both exact tailored files upload on the correct job");
    check(result.submitClicks === 0 && /Final submission was not clicked/.test(result.detail ?? ""), "application stops at review and never submits");
    await page.evaluate(() => (document.querySelector("#submit") as HTMLButtonElement).click());
    check(await page.evaluate(() => (window as unknown as { submitClicks: number }).submitClicks) === 0, "extension-level synthetic final-submit guard blocks programmatic submission");
    const stored = await serviceWorker.evaluate(async () => {
      const scope = globalThis as unknown as { chrome: { storage: { session: { get: (key: string) => Promise<Record<string, unknown>> } } } };
      return scope.chrome.storage.session.get("pendingApplicationBundle");
    }) as { pendingApplicationBundle?: { bundleId?: string; state?: string; transitions?: Array<{ state?: string; at?: string; reason?: string; pageUrl?: string }> } };
    const history = stored.pendingApplicationBundle?.transitions ?? [];
    check(stored.pendingApplicationBundle?.bundleId === transferred.bundleId, "recovery storage keeps one bundle id instead of starting a duplicate attempt");
    check(["QUEUED", "PREPARING_DOCUMENTS", "DOCUMENTS_READY", "OPENING", "SCANNING", "FILLING", "VALIDATING", "NAVIGATING", "REVIEW_READY"].every((state) => history.some((entry) => entry.state === state && entry.at && entry.reason && entry.pageUrl !== undefined)), "state transitions carry timestamps, reasons, page URLs, and reach REVIEW_READY");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-internship-pilot-action="autofill"]')?.getAttribute("data-ip-state") === "filled", null, { timeout: 15_000 });
    check((await serviceWorker.evaluate(async () => {
      const scope = globalThis as unknown as { chrome: { storage: { session: { get: (key: string) => Promise<Record<string, { bundleId?: string }>> } } } };
      return (await scope.chrome.storage.session.get("pendingApplicationBundle")).pendingApplicationBundle?.bundleId;
    })) === transferred.bundleId, "reload safely rescans the same application bundle");
    await page.evaluate(() => {
      (window as unknown as { optionalContinueClicks: number }).optionalContinueClicks = 0;
      const main = document.querySelector("#application");
      if (!main) throw new Error("Application fixture disappeared.");
      main.innerHTML = `<form><label for="attest">I certify that this application is complete</label><input id="attest" type="checkbox"><button id="optional-continue" type="button">Continue</button></form>`;
      document.querySelector("#optional-continue")?.addEventListener("click", () => {
        (window as unknown as { optionalContinueClicks: number }).optionalContinueClicks += 1;
      });
      const agentButton = document.querySelector('[data-internship-pilot-action="autofill"]') as HTMLButtonElement;
      agentButton.dataset.ipState = "ready";
      agentButton.click();
    });
    await page.waitForFunction(() => document.querySelector('[data-internship-pilot-action="autofill"]')?.getAttribute("data-ip-state") === "needs_user", null, { timeout: 15_000 });
    const optionalSafety = await page.evaluate(() => ({
      checked: (document.querySelector("#attest") as HTMLInputElement).checked,
      continueClicks: (window as unknown as { optionalContinueClicks: number }).optionalContinueClicks,
    }));
    check(!optionalSafety.checked && optionalSafety.continueClicks === 0, "optional legal attestations pause before Continue and remain a user action");
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nApplication bundle E2E PASSED." : `\n${failures} application bundle E2E check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
