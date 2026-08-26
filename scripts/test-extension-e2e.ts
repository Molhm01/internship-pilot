import "dotenv/config";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { chromium, type BrowserContext } from "playwright";
import { classifyField, lookupAnswer } from "@/lib/applications/answerBank";
import type { FillContext } from "@/lib/applications/types";

// End-to-end proof that the unpacked Manifest V3 extension actually fills a
// real application form, retains values in framework-controlled (React-style)
// inputs, uploads the resume, reports back, and never submits. The fill PLAN
// is produced by the REAL classifyField/lookupAnswer logic — not a mocked
// success — and the extension does genuine DOM work we then assert on.

const extensionPath = path.resolve(process.cwd(), "extension", "dist");
const testRoot = path.resolve(process.cwd(), "data", "test-runs");
const TOKEN = "e2e-extension-token-000000000000000000000000";
const PROTOCOL_VERSION = 2;

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { console.error(`  FAIL: ${message}`); failures += 1; }
}

// A candidate profile used only by this test (never the user's real data).
const PROFILE = {
  fullName: "Riley Fixture", preferredName: null, email: "riley.fixture@example.com", phone: "555-867-5309",
  linkedin: "linkedin.com/in/rileyfixture", github: "github.com/rileyfixture", website: null,
  school: "New Jersey Institute of Technology", previousSchool: null,
  addressStreet: "1 Engineering Way", addressCity: "Newark", addressState: "NJ", addressZip: "07102",
  countryOfResidence: "United States", willingToRelocate: true, locationPreferences: ["Remote", "New Jersey"],
  internshipTermAvailability: "Summer 2027", earliestStartDate: null, salaryAnswerPreference: "Negotiable",
  workAuthorization: "U.S. Citizen", requiresSponsorship: false, clearanceEligible: null,
  eeoGender: null, eeoRaceEthnicity: null, eeoVeteranStatus: null, eeoDisabilityStatus: null,
};

function fillContext(): FillContext {
  return {
    jobId: "job-e2e", runId: "run-e2e", jobTitle: "Software Engineering Intern", company: "Fixture Robotics",
    applyUrl: "http://127.0.0.1/fixture", mode: "fill_to_submit", profile: PROFILE,
    resumeFilePath: "n/a", coverLetterFilePath: null, coverLetterText: null,
    educationDegree: "B.S. Electrical Engineering", recentExperience: "PC Builder — Freelance",
    approvedRunAnswers: {},
  };
}

// Mirrors the real extensionApi.buildExtensionFillPlan decision logic so the
// plan is genuine, while keeping this test self-contained (no DB/run needed).
const SENSITIVE = /\b(work authorization|authorized to work|sponsorship|citizen|visa|clearance|gender|race|ethnicity|veteran|disabilit|certif|attest|signature|i agree|consent)\b/i;
function buildPlan(fields: Array<{ index: number; label: string; type: string; required: boolean; currentValue: string }>) {
  const ctx = fillContext();
  return fields.map((field) => {
    const label = field.label;
    if (field.currentValue && !["true", "false"].includes(field.currentValue)) {
      return { index: field.index, action: "skip", reason: "Already has a value." };
    }
    if (field.type === "file") {
      return /cover\s*letter/i.test(label)
        ? { index: field.index, action: "skip", reason: "No cover letter attached." }
        : { index: field.index, action: "upload_resume", documentId: "resume-1" };
    }
    const category = classifyField(label);
    if (SENSITIVE.test(label) || category === "work_authorization" || category === "eeo") {
      return { index: field.index, action: "leave_for_user", reason: "Sensitive/legal question — your explicit review." };
    }
    const value = lookupAnswer(ctx, label).value;
    if (value === null) {
      return { index: field.index, action: field.required ? "needs_user" : "skip", reason: field.required ? "No approved answer stored for this required question." : "Optional, no answer." };
    }
    if (field.type === "select") return { index: field.index, action: "select", value };
    if (field.type === "checkbox" || field.type === "radio") {
      return /^(yes|true)$/i.test(value) ? { index: field.index, action: "check", value: true, answer: value } : { index: field.index, action: "skip", reason: "Answer does not require checking." };
    }
    return { index: field.index, action: "fill", value };
  });
}

// A React-style CONTROLLED form: a render loop forces each input's DOM value
// back to the JS "state", so a naive `el.value = x` (without dispatching an
// input event) is reverted. Only the native-setter + input-event path the
// extension uses survives — proving true framework retention.
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Controlled application fixture</title></head>
<body>
<form id="application">
  <label for="first">First name*</label><input id="first" name="first_name" required>
  <label for="last">Last name*</label><input id="last" name="last_name" required>
  <label for="email">Email*</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel">
  <label for="street">Street address</label><input id="street" name="street">
  <label for="city">City</label><input id="city" name="city">
  <label for="school">School*</label><input id="school" name="school" required>
  <label for="degree">Degree*</label><input id="degree" name="degree" required>
  <label for="grad">Graduation date</label><input id="grad" name="grad" type="date">
  <label for="relocate">Are you willing to relocate?</label>
  <select id="relocate" name="relocate"><option value=""></option><option>Yes</option><option>No</option></select>
  <label for="workauth">Are you legally authorized to work? (work authorization)</label>
  <select id="workauth" name="workauth"><option value=""></option><option>Yes</option><option>No</option></select>
  <label for="why">Why are you interested in this role?*</label><textarea id="why" name="why" required></textarea>
  <label for="fav">What is your favorite programming language?*</label><input id="fav" name="fav" required>
  <label for="resume">Resume/CV*</label><input id="resume" name="resume" type="file" required>
  <button type="submit" id="submit">Submit application</button>
</form>
<script>
  // Controlled-input state + render loop (React-like).
  const state = {};
  const controlled = ["first","last","email","phone","street","city","school","degree"];
  for (const id of controlled) {
    const el = document.getElementById(id);
    state[id] = "";
    el.addEventListener("input", () => { state[id] = el.value; });
  }
  setInterval(() => { for (const id of controlled) { const el = document.getElementById(id); if (el.value !== state[id]) el.value = state[id]; } }, 40);
  document.getElementById("application").addEventListener("submit", (e) => { e.preventDefault(); document.body.dataset.submitted = "true"; });
</script>
</body></html>`;

async function makeResumePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Riley Fixture — Resume", { x: 50, y: 740, size: 14, font });
  return Buffer.from(await doc.save());
}

type ServerState = { failFillPlanOnce: boolean; protocolVersion: number; unauthorized: boolean; lastReport: unknown };

function startServer(state: ServerState, resumePdf: Buffer): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const authed = (req.headers.authorization ?? "") === `Bearer ${TOKEN}`;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

    if (url === "/api/extension/health") return json(200, { ok: true, service: "Internship Pilot", protocolVersion: state.protocolVersion, build: "e2e-build", mode: "FILL_TO_SUBMIT", submitEnabled: false });
    if (url === "/api/extension/profile") return authed && !state.unauthorized ? json(200, { ok: true }) : json(401, { error: "unauthorized" });
    if (url === "/fixture") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(FIXTURE_HTML); }

    if (!authed || state.unauthorized) return json(401, { error: "Extension authentication failed." });

    if (url === "/api/extension/fill-plan") {
      if (state.failFillPlanOnce) { state.failFillPlanOnce = false; return json(500, { error: "Simulated transient server failure." }); }
      const body = JSON.parse(await readBody(req));
      return json(200, { runId: "run-e2e", job: { id: "job-e2e", title: "Software Engineering Intern", company: "Fixture Robotics" }, pause: null, fields: buildPlan(body.fields) });
    }
    if (url.startsWith("/api/extension/documents/")) {
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="riley-fixture-resume.pdf"' });
      return res.end(resumePdf);
    }
    if (url === "/api/extension/report") { state.lastReport = JSON.parse(await readBody(req)); return json(200, { ok: true }); }
    return json(404, { error: "not found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const a = server.address(); if (!a || typeof a === "string") return reject(new Error("no port")); resolve({ server, port: a.port }); });
  });
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d || "{}")); });
}

async function seedToken(context: BrowserContext, backendBaseUrl: string, token: string): Promise<string> {
  const [existing] = context.serviceWorkers();
  const worker = existing ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  await worker.evaluate(async ({ apiToken, backendBaseUrl }: { apiToken: string; backendBaseUrl: string }) => {
    const scope = globalThis as unknown as { chrome: { storage: { local: { set: (i: Record<string, string>) => Promise<void> } } } };
    await scope.chrome.storage.local.set({ apiToken, backendBaseUrl });
  }, { apiToken: token, backendBaseUrl });
  return new URL(worker.url()).hostname;
}

async function clickAutofillAndWait(page: import("playwright").Page): Promise<string> {
  const button = page.locator('[data-internship-pilot-action="autofill"]');
  await button.waitFor({ state: "visible", timeout: 15_000 });
  await button.click();
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-internship-pilot-action="autofill"]')?.getAttribute("data-ip-state");
    return s && ["filled", "needs_user", "blocked", "no_form", "backend_unreachable", "error"].includes(s);
  }, undefined, { timeout: 30_000 });
  return (await button.getAttribute("data-ip-state")) ?? "unknown";
}

async function main(): Promise<void> {
  await mkdir(testRoot, { recursive: true });
  const profileDir = await mkdtemp(path.join(testRoot, "e2e-"));
  const resumePdf = await makeResumePdf();
  const state: ServerState = { failFillPlanOnce: false, protocolVersion: PROTOCOL_VERSION, unauthorized: false, lastReport: null };
  const { server, port } = await startServer(state, resumePdf);
  const backendBaseUrl = `http://127.0.0.1:${port}`;

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    await seedToken(context, backendBaseUrl, TOKEN);
    const page = context.pages()[0] ?? await context.newPage();

    console.log("1) Happy path: real fill plan fills the controlled form, retains values, uploads, reports, no submit");
    await page.goto(`${backendBaseUrl}/fixture`, { waitUntil: "domcontentloaded" });
    const state1 = await clickAutofillAndWait(page);
    check(state1 === "needs_user", `run finished in a visible state (needs_user, because of the custom required question) (got ${state1})`);

    // Wait past several controlled re-render ticks, THEN read values — proves retention.
    await page.waitForTimeout(400);
    const values = await page.evaluate(() => ({
      first: (document.getElementById("first") as HTMLInputElement).value,
      last: (document.getElementById("last") as HTMLInputElement).value,
      email: (document.getElementById("email") as HTMLInputElement).value,
      phone: (document.getElementById("phone") as HTMLInputElement).value,
      street: (document.getElementById("street") as HTMLInputElement).value,
      city: (document.getElementById("city") as HTMLInputElement).value,
      school: (document.getElementById("school") as HTMLInputElement).value,
      degree: (document.getElementById("degree") as HTMLInputElement).value,
      relocate: (document.getElementById("relocate") as HTMLSelectElement).value,
      workauth: (document.getElementById("workauth") as HTMLSelectElement).value,
      why: (document.getElementById("why") as HTMLTextAreaElement).value,
      fav: (document.getElementById("fav") as HTMLInputElement).value,
      resumeName: (document.getElementById("resume") as HTMLInputElement).files?.[0]?.name ?? "",
      submitted: document.body.dataset.submitted ?? "",
    }));
    check(values.first === "Riley" && values.last === "Fixture", `first/last name filled & RETAINED in controlled inputs (got "${values.first}"/"${values.last}")`);
    check(values.email === "riley.fixture@example.com", `email filled & retained (got "${values.email}")`);
    check(values.phone === "555-867-5309", `phone filled & retained`);
    check(values.street === "1 Engineering Way" && values.city === "Newark", `address filled & retained`);
    check(values.school === "New Jersey Institute of Technology", `school filled & retained`);
    check(values.degree === "B.S. Electrical Engineering", `degree filled & retained`);
    check(values.relocate === "Yes", `relocation SELECT chosen from profile (got "${values.relocate}")`);
    check(values.workauth === "", `sensitive work-authorization select was LEFT for the user (not auto-answered)`);
    check(values.why === "", `unknown required textarea left blank (reported, not invented)`);
    check(values.fav === "", `unknown required custom question left blank (reported, not invented)`);
    check(values.resumeName === "riley-fixture-resume.pdf", `resume uploaded to the file input (got "${values.resumeName}")`);
    check(values.submitted === "", `Submit was NEVER clicked (default Fill To Submit)`);

    const report = state.lastReport as { state?: string; filledCount?: number; uploadedCount?: number; needsUser?: Array<{ label: string; reason: string }> } | null;
    check(!!report, "dashboard/back-end received a run report");
    check((report?.filledCount ?? 0) >= 6, `report.filledCount reflects real fills (got ${report?.filledCount})`);
    check((report?.uploadedCount ?? 0) === 1, `report.uploadedCount = 1`);
    check(!!report?.needsUser?.some((f) => /favorite programming language/i.test(f.label) && /no approved/i.test(f.reason)), "skipped custom question reported with a useful reason");
    check(!!report?.needsUser?.some((f) => /work authorization|authorized to work/i.test(f.label)), "sensitive field reported for user review");

    console.log("\n2) Recovery: a transient server failure does not permanently break future runs");
    state.failFillPlanOnce = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    const failState = await clickAutofillAndWait(page);
    check(failState === "error", `first run after forced 500 surfaces an explicit error state (got ${failState})`);
    const retryState = await clickAutofillAndWait(page);
    check(retryState === "needs_user", `a SECOND run immediately succeeds after the failure (got ${retryState})`);

    console.log("\n3) Invalid token is a distinct, visible failure");
    state.unauthorized = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    const unauthState = await clickAutofillAndWait(page);
    check(unauthState === "error", `unauthorized backend produces a visible error (not silent) (got ${unauthState})`);
    state.unauthorized = false;

    console.log("\n4) Version mismatch is reported explicitly and blocks the fill");
    state.protocolVersion = 999;
    // The background caches health; force a re-check by reloading the service worker's cache via a fresh health call.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    await page.reload({ waitUntil: "domcontentloaded" });
    const mismatchState = await clickAutofillAndWait(page);
    check(mismatchState === "error", `protocol mismatch blocks the fill with an explicit error (got ${mismatchState})`);
    const mismatchDetail = await page.locator('[data-internship-pilot-action="autofill"]').getAttribute("data-ip-detail");
    check(/mismatch|protocol/i.test(mismatchDetail ?? ""), `mismatch error message mentions the version problem`);

    console.log("\n5) Cleanup");
    console.log("  done");
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const resolved = path.resolve(profileDir);
    if (resolved.startsWith(testRoot) && path.basename(resolved).startsWith("e2e-")) await rm(resolved, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nAll extension e2e tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
