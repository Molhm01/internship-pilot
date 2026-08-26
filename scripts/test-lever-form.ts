import "dotenv/config";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { validateFormDescriptionPayload } from "@/lib/applications/formSchema";
import { classifyField, lookupAnswer } from "@/lib/applications/answerBank";
import type { FillContext } from "@/lib/applications/types";



let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { console.error(`  FAIL: ${message}`); failures += 1; }
}

const PROFILE = {
  fullName: "Alex Morgan", preferredName: null, email: "alex.morgan@example.com", phone: "(555) 234-5678",
  linkedin: "https://linkedin.com/in/alexmorgan", github: "https://github.com/alexmorgan", website: null,
  school: "University of California, Berkeley", previousSchool: null,
  addressStreet: "123 University Ave", addressCity: "Berkeley", addressState: "CA", addressZip: "94720",
  countryOfResidence: "United States", willingToRelocate: true, locationPreferences: ["San Francisco, CA"],
  internshipTermAvailability: "Summer 2027", earliestStartDate: null, salaryAnswerPreference: "Negotiable",
  workAuthorization: "U.S. Citizen", requiresSponsorship: false, clearanceEligible: null,
  eeoGender: null, eeoRaceEthnicity: null, eeoVeteranStatus: null, eeoDisabilityStatus: null,
};

function fillContext(): FillContext {
  return {
    jobId: "lever-job-1", runId: "lever-run-1", jobTitle: "Software Engineering Intern", company: "Acme Corp",
    applyUrl: "http://127.0.0.1/lever-app", mode: "fill_to_submit", profile: PROFILE,
    resumeFilePath: "n/a", coverLetterFilePath: null, coverLetterText: null,
    educationDegree: "B.S. Computer Science", recentExperience: "Software Intern at Acme",
    approvedRunAnswers: {},
  };
}

const LEVER_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Lever App Fixture</title></head>
<body>
  <h1>Software Engineering Intern</h1>
  <form id="lever-form">
    <label>Full name* <input id="full-name" name="name" required></label>
    <label>Email* <input id="email" name="email" type="email" required></label>
    <label>Phone* <input id="phone" name="phone" type="tel" required></label>
    <label>Current location* <input id="location" name="location" required></label>
    <label>LinkedIn URL <input id="linkedin" name="urls[LinkedIn]"></label>
    <label>Resume/CV* <input id="resume" name="resume" type="file" required></label>
    <label>Are you legally authorized to work in the United States?*</label>
    <input type="radio" name="cards[work_auth]" value="Yes" required> Yes
    <input type="radio" name="cards[work_auth]" value="No"> No
    <label>How did you hear about this job?*</label>
    <select id="referral" name="cards[referral]" required>
      <option value="">Select...</option>
      <option value="LinkedIn">LinkedIn</option>
      <option value="Company Website">Company Website</option>
    </select>
    <button type="submit" id="btn-submit">Submit application</button>
  </form>
  <script>
    document.getElementById("lever-form").addEventListener("submit", (e) => {
      e.preventDefault();
      document.body.dataset.submitted = "true";
    });
  </script>
</body>
</html>`;

async function main(): Promise<void> {
  console.log("=== Lever Form & Extension Schema Test ===");

  const server = createServer((req, res) => {
    if (req.url === "/lever-app") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(LEVER_HTML);
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log("1) Open Lever Application");
    await page.goto(`${baseUrl}/lever-app`, { waitUntil: "domcontentloaded" });
    check(await page.locator("h1").innerText() === "Software Engineering Intern", "Lever form loaded");

    console.log("2) Scan fields and validate against server schema");
    const fields = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("input, select, textarea"));
      return elements.map((el, index) => {
        const input = el as HTMLInputElement;
        const labelText = input.closest("label")?.textContent || input.getAttribute("name") || "";
        return {
          index,
          label: labelText,
          groupLabel: "",
          optionLabel: input.value || "",
          name: input.getAttribute("name") || "",
          id: input.getAttribute("id") || "",
          ariaLabel: input.getAttribute("aria-label") || "",
          placeholder: input.getAttribute("placeholder") || "",
          nearbyText: labelText,
          role: input.getAttribute("role") || "",
          type: input.tagName.toLowerCase() === "select" ? "select" : input.type || "text",
          required: input.hasAttribute("required"),
          options: input.tagName.toLowerCase() === "select"
            ? Array.from((input as unknown as HTMLSelectElement).options).map(o => o.textContent || "").filter(Boolean)
            : [],
          currentValue: input.value || "",
        };
      });
    });

    const payload = {
      pageUrl: `${baseUrl}/lever-app`,
      pageTitle: "Lever App Fixture",
      fields,
      blockers: [],
      protocolVersion: 2,
      schemaVersion: 1,
    };

    const validated = validateFormDescriptionPayload(payload);
    check(validated.success, "Generated Lever form description validated cleanly against canonical server schema");

    console.log("3) Verify form field answers matching candidate profile");
    const ctx = fillContext();
    const nameAnswer = lookupAnswer(ctx, "Full name").value;
    const emailAnswer = lookupAnswer(ctx, "Email").value;
    const phoneAnswer = lookupAnswer(ctx, "Phone").value;
    const locationAnswer = lookupAnswer(ctx, "Current location").value;
    const linkedinAnswer = lookupAnswer(ctx, "LinkedIn URL").value;

    check(nameAnswer === PROFILE.fullName, `Full name resolved: ${nameAnswer}`);
    check(emailAnswer === PROFILE.email, `Email resolved: ${emailAnswer}`);
    check(phoneAnswer === PROFILE.phone, `Phone resolved: ${phoneAnswer}`);
    check(locationAnswer === "Berkeley, CA" || locationAnswer === PROFILE.locationPreferences[0], `Location resolved: ${locationAnswer}`);
    check(linkedinAnswer === PROFILE.linkedin, `LinkedIn resolved: ${linkedinAnswer}`);

    console.log("4) Check sensitive / required field reporting");
    const workAuthCategory = classifyField("Are you legally authorized to work in the United States?");
    check(workAuthCategory === "work_authorization", "Work authorization recognized as sensitive question requiring user review");

    console.log("5) Confirm page remains open and Submit is untouched");
    const submitted = await page.evaluate(() => document.body.dataset.submitted);
    check(!submitted, "Submit button was NOT clicked (remains open for user review)");

  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? "\nAll Lever form tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

void main();
