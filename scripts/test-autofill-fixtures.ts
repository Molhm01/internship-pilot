import path from "node:path";
import { chromium, type Page } from "playwright";

let failures = 0;
function check(condition: unknown, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { failures += 1; console.error(`  FAIL: ${message}`); }
}

const fingerprint = "a".repeat(64);
const bundle = {
  bundleVersion: 3,
  websiteJobId: "job-fixture",
  company: "Northwind Robotics",
  jobTitle: "Software Engineering Intern",
  jobDescription: "Build accessible React form workflows with TypeScript.",
  officialApplicationUrl: "https://fixture.invalid/apply",
  documentFingerprint: fingerprint,
  profile: {
    version: 3,
    personal: {
      legalFirstName: "Riley", legalLastName: "Fixture", preferredName: "Rye",
      email: "riley.fixture@example.com", phone: "2125550199", phoneCountryCode: "+1",
      address: { line1: "42 Test Lane", line2: "Apt 3", city: "New York", state: "NY", postalCode: "10001", country: "United States" },
      linkedin: "https://linkedin.com/in/riley-fixture", github: "https://github.com/riley-fixture", portfolio: "https://riley.example",
    },
    education: [{ id: "edu-1", institution: "Example University", degree: "Bachelor of Science", major: "Computer Science", graduationDate: "2027-05", gpa: 3.8 }],
    projects: [{ id: "project-1", name: "Accessible Forms", description: "built a typed form workflow", technologies: ["React", "TypeScript"], accomplishments: [] }],
    experience: [],
    skills: { technical: ["React", "TypeScript"], programmingLanguages: ["TypeScript"] },
    eligibility: { workAuthorization: "Authorized to work in the United States", requiresSponsorshipNow: false, willingToRelocate: true, meetsMinimumAge: true },
    sensitivePolicies: [{ category: "gender", policy: "decline_to_answer" }],
  },
  approvedAnswers: [],
  answerContext: { neverClaimFacts: ["Kubernetes"] },
  companyRelationship: { companyName: "Northwind Robotics", previouslyEmployed: false, previouslyApplied: false, familyMemberEmployed: false },
  documents: [
    { kind: "resume", filename: "Resume-Northwind.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0xLjQK", byteLength: 9, generatedAt: "2026-08-23T12:00:00.000Z", websiteJobId: "job-fixture", documentFingerprint: fingerprint, qaStatus: "pass", identityVerified: true },
    { kind: "cover_letter", filename: "Cover-Letter-Northwind.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0xLjQK", byteLength: 9, generatedAt: "2026-08-23T12:00:00.000Z", websiteJobId: "job-fixture", documentFingerprint: fingerprint, qaStatus: "pass", identityVerified: true },
  ],
};

async function load(page: Page, html: string) {
  await page.setContent(html);
  await page.addScriptTag({ path: path.resolve("extension/dist/autofill-engine.js") });
}

async function fill(page: Page) {
  return page.evaluate(async (applicationBundle) => {
    const engine = (globalThis as unknown as { InternshipPilotAutofillEngine: {
      scanFields: () => Array<{ index: number; element: Element; required: boolean }>;
      fillField: (field: unknown, bundle: unknown) => Promise<Record<string, unknown>>;
      requiredAudit: (fields: unknown[], results: unknown[]) => Array<{ status: string; concept: string }>;
      classifyField: (field: unknown) => string;
    } }).InternshipPilotAutofillEngine;
    const fields = engine.scanFields();
    const results = [];
    for (const field of fields) results.push({ index: field.index, ...(await engine.fillField(field, applicationBundle)) });
    return {
      descriptors: fields.map((field) => ({ concept: engine.classifyField(field), required: field.required })),
      results,
      audit: engine.requiredAudit(fields, results),
    };
  }, bundle);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    console.log("\n1) Generic HTML: profile, semantic selects, radio/checkbox, files, free response, required audit");
    await load(page, `<!doctype html><form>
      <label for="first">First name *</label><input id="first" required>
      <label for="last">Last name *</label><input id="last" required>
      <label for="full">Full legal name *</label><input id="full" required>
      <label for="email">Email *</label><input id="email" type="email" required>
      <label for="phoneCode">Country code *</label><input id="phoneCode" required>
      <label for="phone">Phone *</label><input id="phone" type="tel" required>
      <label for="address">Address line 1 *</label><input id="address" required>
      <label for="city">City *</label><input id="city" required>
      <label for="state">State *</label><select id="state" required><option value="">Choose</option><option>New York</option></select>
      <label for="zip">ZIP *</label><input id="zip" required>
      <label for="country">Country *</label><select id="country" required><option value="">Choose</option><option>United States of America</option></select>
      <label for="school">School *</label><input id="school" required>
      <label for="degree">Degree *</label><input id="degree" required>
      <label for="major">Major *</label><input id="major" required>
      <label for="gradMonth">Graduation month *</label><select id="gradMonth" required><option value="">Choose</option><option>May</option></select>
      <label for="gradYear">Graduation year *</label><input id="gradYear" required>
      <label for="linkedin">LinkedIn</label><input id="linkedin" type="url">
      <label for="github">GitHub</label><input id="github" type="url">
      <label for="portfolio">Portfolio</label><input id="portfolio" type="url">
      <label for="gpa">GPA</label><input id="gpa" type="number">
      <label for="auth">Are you authorized to work in the United States? *</label><select id="auth" required><option value="">Choose</option><option>Authorized to work in the United States</option></select>
      <label for="sponsor">Will you require sponsorship? *</label><select id="sponsor" required><option value="">Choose</option><option>No</option><option>Yes</option></select>
      <fieldset><legend>Are you willing to relocate? *</legend><label><input type="radio" name="relocate" value="Yes" required>Yes</label><label><input type="radio" name="relocate" value="No" required>No</label></fieldset>
      <label><input id="age" type="checkbox" required>Are you at least 18 years old? *</label>
      <label for="gender">Gender *</label><select id="gender" required><option value="">Choose</option><option>I do not wish to answer</option></select>
      <label for="why">Why are you interested in this role? *</label><textarea id="why" required></textarea>
      <label for="unknown">Favorite animal *</label><input id="unknown" required>
      <label for="resume">Resume *</label><input id="resume" type="file" required>
      <label for="cover">Cover letter *</label><input id="cover" type="file" required>
      <button type="button">Continue</button><button id="submit" type="submit">Submit Application</button>
    </form>`);
    const generic = await fill(page);
    const values = await page.evaluate(() => ({
      first: (document.querySelector("#first") as HTMLInputElement).value,
      last: (document.querySelector("#last") as HTMLInputElement).value,
      full: (document.querySelector("#full") as HTMLInputElement).value,
      email: (document.querySelector("#email") as HTMLInputElement).value,
      phoneCode: (document.querySelector("#phoneCode") as HTMLInputElement).value,
      city: (document.querySelector("#city") as HTMLInputElement).value,
      state: (document.querySelector("#state") as HTMLSelectElement).value,
      country: (document.querySelector("#country") as HTMLSelectElement).value,
      gradMonth: (document.querySelector("#gradMonth") as HTMLSelectElement).value,
      degree: (document.querySelector("#degree") as HTMLInputElement).value,
      major: (document.querySelector("#major") as HTMLInputElement).value,
      gradYear: (document.querySelector("#gradYear") as HTMLInputElement).value,
      github: (document.querySelector("#github") as HTMLInputElement).value,
      portfolio: (document.querySelector("#portfolio") as HTMLInputElement).value,
      gpa: (document.querySelector("#gpa") as HTMLInputElement).value,
      sponsor: (document.querySelector("#sponsor") as HTMLSelectElement).value,
      relocation: (document.querySelector("input[name=relocate]:checked") as HTMLInputElement | null)?.value,
      age: (document.querySelector("#age") as HTMLInputElement).checked,
      gender: (document.querySelector("#gender") as HTMLSelectElement).value,
      why: (document.querySelector("#why") as HTMLTextAreaElement).value,
      unknown: (document.querySelector("#unknown") as HTMLInputElement).value,
      resume: (document.querySelector("#resume") as HTMLInputElement).files?.[0]?.name,
      cover: (document.querySelector("#cover") as HTMLInputElement).files?.[0]?.name,
    }));
    check(values.first === "Riley" && values.last === "Fixture" && values.full === "Riley Fixture" && values.email === bundle.profile.personal.email, "first, last, full name, and contact fields fill");
    check(values.phoneCode === "+1" && values.city === "New York", "country code and address fields fill");
    check(values.state === "New York" && values.country === "United States of America", "state/country semantic equivalents select");
    check(values.gradMonth === "May", "graduation month number maps to month name");
    check(values.degree === "Bachelor of Science" && values.major === "Computer Science" && values.gradYear === "2027" && values.gpa === "3.8", "degree, major, graduation year, and GPA fill");
    check(values.github === bundle.profile.personal.github && values.portfolio === bundle.profile.personal.portfolio, "GitHub and portfolio links fill");
    check(values.sponsor === "No" && values.relocation === "Yes" && values.age, "authorization-style select, radio, and checkbox fill from explicit values");
    check(values.gender === "I do not wish to answer", "saved EEO decline maps to an equivalent option");
    check((values.why?.length ?? 0) > 60 && !values.why?.includes("Kubernetes"), "free response is grounded and excludes never-claim facts");
    check(values.unknown === "", "unknown required question is never guessed");
    check(values.resume === "Resume-Northwind.pdf" && values.cover === "Cover-Letter-Northwind.pdf", "exact job-scoped résumé and cover letter bytes upload");
    check(generic.audit.some((entry) => entry.concept === "UNKNOWN" && entry.status === "NEEDS_USER"), "required-field audit classifies unknown required field as NEEDS_USER");

    console.log("\n2) React-controlled and ARIA/searchable combobox controls");
    await load(page, `<!doctype html><form>
      <label for="reactEmail">Email *</label><input id="reactEmail" required>
      <label for="formattedPhone">Phone *</label><input id="formattedPhone" type="tel" required>
      <label id="schoolLabel" for="schoolCombo">School *</label><input id="schoolCombo" role="combobox" aria-labelledby="schoolLabel" aria-controls="schoolList" required>
      <div id="schoolList" role="listbox"><div id="schoolOption" role="option">Example University</div></div>
      <button type="submit">Submit Application</button>
      <script>
        let controlled = ""; const email = document.querySelector("#reactEmail");
        email.addEventListener("input", (event) => { controlled = event.target.value; });
        setInterval(() => { if (email.value !== controlled) email.value = controlled; }, 20);
        const phone = document.querySelector("#formattedPhone");
        phone.addEventListener("input", () => { const digits = phone.value.replace(/\\D/g, ""); phone.value = digits.length === 10 ? '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6) : digits; });
        const combo = document.querySelector("#schoolCombo"); const option = document.querySelector("#schoolOption");
        option.addEventListener("click", () => { combo.value = option.textContent; option.setAttribute("aria-selected", "true"); });
      </script>
    </form>`);
    const react = await fill(page);
    await page.waitForTimeout(200);
    const reactValues = await page.evaluate(() => ({ email: (document.querySelector("#reactEmail") as HTMLInputElement).value, phone: (document.querySelector("#formattedPhone") as HTMLInputElement).value, school: (document.querySelector("#schoolCombo") as HTMLInputElement).value }));
    check(reactValues.email === bundle.profile.personal.email, "React-controlled input stays filled after its event cycle");
    check(reactValues.phone === "(212) 555-0199", "employer-normalized phone formatting is accepted after verification");
    check(reactValues.school === "Example University", "ARIA searchable combobox selects and verifies an option");
    check(react.audit.every((entry) => entry.status === "FILLED"), "React/ARIA required audit passes");

    console.log("\n3) ATS-specific accessible markup recognition");
    const fixtures = [
      ["Greenhouse", `<div class="application-question"><label for="gh">First Name</label><input id="gh" required><button>Submit Application</button></div>`],
      ["Lever", `<div class="application-question"><label for="lever">LinkedIn URL</label><input id="lever" required><button>Submit Application</button></div>`],
      ["Workday", `<div data-automation-id="formField-email"><label for="wd">Email Address</label><input id="wd" required><button>Submit</button></div>`],
      ["custom React", `<div role="group" aria-label="Candidate"><label for="custom">Portfolio website</label><input id="custom" required><button>Complete Application</button></div>`],
    ] as const;
    for (const [name, html] of fixtures) {
      await load(page, `<form>${html}</form>`);
      const result = await fill(page);
      check(result.audit.every((entry) => entry.status === "FILLED"), `${name} fixture recognized and filled`);
    }
    await load(page, `<form><section><h2>Phone</h2><label for="countryInPhone">Country*</label><input id="countryInPhone" name="country" required></section></form>`);
    const countryInPhoneSection = await page.evaluate(() => {
      const engine = (globalThis as unknown as { InternshipPilotAutofillEngine: { scanFields: () => Array<unknown>; classifyField: (field: unknown) => string } }).InternshipPilotAutofillEngine;
      const field = engine.scanFields()[0];
      return engine.classifyField(field);
    });
    check(countryInPhoneSection === "COUNTRY", "Country fields are not misclassified from a surrounding Phone section");
    await load(page, `<form><label for="posting">Which location are you closest to?</label><input id="posting" name="preferredPostingLocation"><label for="site">Website</label><input id="site" name="Website"></form>`);
    const ashbyLabels = await page.evaluate(() => {
      const engine = (globalThis as unknown as { InternshipPilotAutofillEngine: { scanFields: () => Array<unknown>; classifyField: (field: unknown) => string } }).InternshipPilotAutofillEngine;
      return engine.scanFields().map((field) => engine.classifyField(field));
    });
    check(ashbyLabels[0] === "UNKNOWN" && ashbyLabels[1] === "PORTFOLIO", "Ashby posting location is not mistaken for referral and Website maps to portfolio");

    console.log("\n4) Employer-scoped answers, legal pauses, validation rejection, and value reversion");
    await load(page, `<form>
      <label for="worked">Have you ever worked for this company before? *</label><select id="worked" required><option value="">Choose</option><option>No</option><option>Yes</option></select>
      <label for="applied">Have you previously applied? *</label><select id="applied" required><option value="">Choose</option><option>No</option><option>Yes</option></select>
      <label for="relative">Do you have a relative employed here? *</label><select id="relative" required><option value="">Choose</option><option>No</option><option>Yes</option></select>
      <label for="legal">I certify this application is complete *</label><input id="legal" required>
      <label for="revert">Email *</label><input id="revert" required>
      <label for="invalidCity">City *</label><input id="invalidCity" aria-invalid="true" required><span role="alert">Enter a supported city</span>
      <button type="submit">Submit Application</button>
      <script>document.querySelector('#revert').addEventListener('input', (event) => setTimeout(() => { event.target.value = ''; }, 0));</script>
    </form>`);
    const safety = await fill(page);
    const safetyValues = await page.evaluate(() => ({
      worked: (document.querySelector("#worked") as HTMLSelectElement).value,
      applied: (document.querySelector("#applied") as HTMLSelectElement).value,
      relative: (document.querySelector("#relative") as HTMLSelectElement).value,
      legal: (document.querySelector("#legal") as HTMLInputElement).value,
      revert: (document.querySelector("#revert") as HTMLInputElement).value,
    }));
    check(safetyValues.worked === "No" && safetyValues.applied === "No" && safetyValues.relative === "No", "company relationship answers are used only from the current employer bundle");
    check(safetyValues.legal === "" && safety.audit.some((entry) => entry.status === "NEEDS_USER"), "legal attestation remains a user action");
    check(safetyValues.revert === "" && safety.results.some((entry) => (entry as { reason?: string }).reason === "VALUE_REVERTED"), "a field that clears itself is reported instead of falsely counted filled");
    check(safety.audit.some((entry) => entry.status === "BLOCKED"), "aria-invalid employer rejection blocks required-field completion");

    console.log("\n5) Navigation and irreversible action classification");
    const actions = await page.evaluate(() => {
      const engine = (globalThis as unknown as { InternshipPilotAutofillEngine: { nextAction: () => Element | null; finalAction: () => Element | null } }).InternshipPilotAutofillEngine;
      return { next: engine.nextAction()?.textContent, final: engine.finalAction()?.textContent };
    });
    check(!actions.next && /Submit Application|Complete Application/.test(actions.final ?? ""), "final action is never misclassified as Continue");
    await load(page, `<form><label for="city2">City</label><input id="city2"><button type="button">Save and Continue</button><button type="submit">Submit Application</button></form>`);
    const navigation = await page.evaluate(() => {
      const engine = (globalThis as unknown as { InternshipPilotAutofillEngine: { nextAction: () => Element | null; finalAction: () => Element | null } }).InternshipPilotAutofillEngine;
      return { next: engine.nextAction()?.textContent, final: engine.finalAction()?.textContent };
    });
    check(navigation.next === "Save and Continue" && navigation.final === "Submit Application", "multi-page Continue is distinct from final Submit");

    console.log("\n6) CAPTCHA, MFA, and account-creation pauses");
    for (const [name, html, kind] of [
      ["CAPTCHA", `<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>`, "captcha"],
      ["MFA", `<label>Verification code<input autocomplete="one-time-code"></label>`, "mfa"],
      ["account creation", `<h1>Create account</h1><label>Set password<input type="password"></label>`, "account_creation"],
      ["Workday account start", `<h1>Start Your Application</h1><a>Sign In</a><button>Apply Manually</button>`, "account_creation"],
    ] as const) {
      await load(page, html);
      const blockers = await page.evaluate(() => (globalThis as unknown as { InternshipPilotAutofillEngine: { blockers: () => Array<{ kind: string }> } }).InternshipPilotAutofillEngine.blockers());
      check(blockers[0]?.kind === kind, `${name} pauses for user intervention`);
    }
    await load(page, `<h1>CAREERS AT NVIDIA</h1><button>Sign In</button>`);
    const workdayBoundary = await page.evaluate(() => (globalThis as unknown as { InternshipPilotAutofillEngine: { blockers: () => Array<{ kind: string; code: string }> } }).InternshipPilotAutofillEngine.blockers());
    check(workdayBoundary[0]?.kind === "authentication" && workdayBoundary[0]?.code === "AUTHENTICATION_REQUIRED", "Workday sign-in-only application boundary pauses without retrying");
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nAll autofill fixtures PASSED." : `\n${failures} autofill fixture(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
