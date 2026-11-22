import http from "node:http";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChromiumExecutablePath } from "./chromiumExecutable";
import {
  extractConfirmationNumberFromText,
  looksLikeSubmissionConfirmation,
  resolveGroundedFieldAnswer,
  runPlaywrightApplication,
  stopReasonForCategory,
} from "./remoteBrowserRunner";
import type { FillContext } from "./types";

function makeTestContext(overrides: Partial<FillContext> = {}): FillContext {
  return {
    jobId: "test-job-1",
    runId: "test-run-abcdef",
    jobTitle: "Software Engineering Intern",
    company: "Acme Robotics",
    applyUrl: "http://127.0.0.1:3000/mock-ats/lever-autosubmit.html",
    mode: "auto_submit",
    profile: {
      fullName: "Samira Pilot",
      legalFirstName: "Samira",
      legalLastName: "Pilot",
      legalMiddleName: null,
      noMiddleName: true,
      preferredName: "Samira Pilot",
      email: "samira.pilot@test.dev",
      alternateEmail: null,
      phone: "555-019-2834",
      phoneCountryCode: "+1",
      addressStreet: "100 Campus Way",
      addressLine2: null,
      addressCity: "Ann Arbor",
      addressState: "MI",
      addressZip: "48109",
      countryOfResidence: "United States",
      metroRegion: "Ann Arbor",
      linkedin: "https://linkedin.com/in/samirapilot",
      github: "https://github.com/samirapilot",
      portfolio: "https://samirapilot.dev",
      website: "https://samirapilot.dev",
      school: "University of Michigan",
      degreeType: "B.S.",
      educationLevel: "Bachelor's",
      major: "Computer Science",
      minor: null,
      gpa: "3.9",
      graduationDate: "2027-05",
      earliestStartDate: "2027-05-15",
      internshipTermAvailability: "Summer 2027",
      workAuthorization: "U.S. Citizen",
      requiresSponsorship: false,
      securityClearanceStatus: null,
      clearanceEligible: null,
      meetsMinimumAge: true,
      hasDriversLicense: true,
      willingToRelocate: true,
      remotePreference: "Hybrid",
      eeoGender: null,
      eeoRaceEthnicity: null,
      eeoVeteranStatus: null,
      eeoDisabilityStatus: null,
      pronouns: null,
      referralSource: "Company Career Site",
      salaryAnswerPreference: null,
      previousSchool: null,
      locationPreferences: null,
    },
    resumeFilePath: "data/generated/test-resume.pdf",
    coverLetterFilePath: null,
    coverLetterText: "Excited to contribute to Acme Robotics.",
    educationDegree: "B.S. Computer Science",
    recentExperience: "Systems Engineering Intern",
    approvedRunAnswers: {},
    ...overrides,
  };
}

describe("remoteBrowserRunner pure helpers", () => {
  it("extracts confirmation numbers and detects confirmation pages", () => {
    expect(
      extractConfirmationNumberFromText("Thank you for applying! Confirmation: LEV-83921"),
    ).toBe("LEV-83921");
    expect(
      extractConfirmationNumberFromText("Confirmation Number: WD-77410"),
    ).toBe("WD-77410");
    expect(
      looksLikeSubmissionConfirmation(
        "Thank you for applying! We have received your application.",
        "https://jobs.example.com/apply",
        "https://jobs.example.com/apply",
      ),
    ).toBe(true);
    expect(
      looksLikeSubmissionConfirmation(
        "Fill out your info",
        "https://jobs.example.com/apply",
        "https://jobs.example.com/apply/thank-you",
      ),
    ).toBe(true);
    expect(
      looksLikeSubmissionConfirmation(
        "Fill out your info",
        "https://jobs.example.com/apply",
        "https://jobs.example.com/apply",
      ),
    ).toBe(false);
    expect(
      looksLikeSubmissionConfirmation(
        "Search Results: 120 jobs thank you",
        "https://jobs.paccar.com/job/123",
        "https://jobs.paccar.com/search/?q=N%2FA",
      ),
    ).toBe(false);
  });

  it("maps ungrounded categories to honest stop reasons", () => {
    expect(stopReasonForCategory("eeo", "select")).toBe("eeo_no_saved_preference");
    expect(stopReasonForCategory("work_authorization", "select")).toBe(
      "citizenship_clearance_sponsorship_ambiguous",
    );
    expect(stopReasonForCategory("unknown", "textarea")).toBe("essay_without_approved_answer");
    expect(stopReasonForCategory("unknown", "input")).toBe("unknown_question");
  });

  it("gates terms checkboxes unless explicitly approved", () => {
    const ctx = makeTestContext();
    const stopped = resolveGroundedFieldAnswer(
      ctx,
      {},
      "I agree to the Terms of Service and certify my application",
      { type: "checkbox", tag: "input" },
    );
    expect(stopped.value).toBeNull();
    expect(stopped.stopReason).toBe("terms_confirmation_required");

    const approved = resolveGroundedFieldAnswer(
      makeTestContext({
        approvedRunAnswers: {
          "i agree to the terms of service and certify my application": "Yes",
        },
      }),
      {},
      "I agree to the Terms of Service and certify my application",
      { type: "checkbox", tag: "input" },
    );
    expect(approved.value).toBe("Yes");
  });
});

describe("remoteBrowserRunner live Chromium mock-ATS execution", () => {
  let server: http.Server;
  let baseUrl: string;
  const mockPdfBytes = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"));
  const tmpRunRoot = path.join("data", "generated", "test-browser-runner-unit");

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const reqPath = (req.url ?? "/").split("?")[0];
      if (reqPath === "/mock-inline/403") {
        res.statusCode = 403;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<html><body><h1>403 Forbidden</h1></body></html>");
        return;
      }
      if (reqPath === "/mock-inline/footer-search-and-apply") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <header><form action="/search/" role="search"><input name="q" placeholder="Search by Keyword" /><button type="submit">Search</button></form></header>
          <main>
            <button data-testid="Apply now" onclick="document.getElementById('apply-form').style.display='block'">Apply now</button>
            <form id="apply-form" style="display:none" onsubmit="event.preventDefault(); document.getElementById('done').style.display='block'">
              <label for="fullName">Full Name</label><input id="fullName" name="fullName" required />
              <label for="email">Email</label><input id="email" name="email" type="email" required />
              <div class="form-group">
                <label>Add Resume*</label>
                <input id="file-input-0" type="file" style="display:none" />
              </div>
              <button type="submit">Submit Application</button>
            </form>
            <div id="done" style="display:none">Thank you! Application submitted. Confirmation: RIP-99123</div>
          </main>
          <footer><input id="input-select-search-input" type="text" placeholder="Language" /></footer>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/portal-account") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <div id="auth-view">
            <h2>Sign In</h2>
            <a href="#" data-automation-id="createAccountLink" onclick="event.preventDefault(); document.getElementById('verifyPw').style.display='block'; document.getElementById('createBtn').style.display='inline-block'; document.getElementById('signInBtn').style.display='none'">Create Account</a>
            <label for="email">Email</label><input id="email" type="email" />
            <label for="pw">Password</label><input id="pw" type="password" />
            <div id="verifyPw" style="display:none"><label for="pw2">Verify New Password</label><input id="pw2" type="password" /></div>
            <button id="signInBtn" type="button">Sign In</button>
            <button id="createBtn" data-automation-id="createAccountSubmitButton" type="button" style="display:none" onclick="
              if (document.getElementById('pw').value === 'Molhmiscool21!' && document.getElementById('pw2').value === 'Molhmiscool21!') {
                document.getElementById('auth-view').style.display='none';
                document.getElementById('verified-msg').style.display='block';
              }
            ">Create Account</button>
          </div>
          <div id="verified-msg" style="display:none">Please verify your email! We sent a verification email to your address.</div>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/eightfold-ms") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <div id="dlg" role="dialog" aria-modal="true">
            <div id="step-signin">
              <h2>Sign in</h2>
              <button type="button" onclick="openPopup()">Sign in using Microsoft</button>
              <button type="button" onclick="document.getElementById('step-signin').style.display='none'; document.getElementById('step-consent').style.display='block'">Create an account</button>
            </div>
            <div id="step-consent" style="display:none">
              <h2>Please review before continuing</h2>
              <input role="combobox" aria-label="Country" oninput="document.getElementById('country-list').style.display='block'; document.getElementById('ai-radio').style.display='block'" />
              <div id="country-list" role="listbox" style="display:none"><div role="option" onclick="document.getElementById('country-list').style.display='none'">United States</div></div>
              <div id="ai-radio" style="display:none">
                <label><input type="radio" name="ai" value="yes" /> Yes, allow</label>
                <label><input type="radio" name="ai" value="no" /> No</label>
              </div>
              <label><input id="c1" type="checkbox" /> Terms</label>
              <div id="consent-err" style="color:red"></div>
              <button type="button" onclick="
                if (!document.querySelector('input[name=ai]:checked')) {
                  document.getElementById('consent-err').textContent = 'Please choose your preferred AI-insights visibility setting to continue';
                  return;
                }
                document.getElementById('step-consent').style.display='none';
                document.getElementById('step-signup').style.display='block';
              ">Submit</button>
            </div>
            <div id="step-signup" style="display:none">
              <h2>Sign Up</h2>
              <button type="button" onclick="openPopup()">Sign up using Microsoft</button>
            </div>
          </div>
          <form id="app-form" style="display:none" onsubmit="event.preventDefault(); document.getElementById('done').style.display='block'">
            <label for="fullName">Full Name</label><input id="fullName" name="fullName" required />
            <label for="resume">Resume</label><input id="resume" type="file" />
            <button type="submit">Submit Application</button>
          </form>
          <div id="done" style="display:none">Thank you! Application submitted. Confirmation: MS-55210</div>
          <script>
            function openPopup() {
              window.open('/mock-inline/ms-oauth-popup', 'ms', 'width=500,height=600');
            }
            window.addEventListener('message', (e) => {
              if (e.data === 'ms-auth-ok') {
                document.getElementById('dlg').style.display='none';
                document.getElementById('app-form').style.display='block';
              }
            });
          </script>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/ms-oauth-popup") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <div id="email-step">
            <input name="loginfmt" type="email" />
            <input id="idSIButton9" type="submit" value="Next" onclick="document.getElementById('email-step').style.display='none'; document.getElementById('pw-step').style.display='block'" />
          </div>
          <div id="pw-step" style="display:none">
            <input name="passwd" type="password" />
            <input id="idSIButton9" type="submit" value="Sign in" onclick="
              if (document.querySelector('input[name=passwd]').value === 'Molhmiscool21!') {
                if (window.opener) window.opener.postMessage('ms-auth-ok', '*');
                window.close();
              }
            " />
          </div>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/greenhouse-combobox-and-recovery") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <form id="gh-form" novalidate>
            <label for="first_name">First Name*</label><input id="first_name" name="first_name" required />
            <label for="last_name">Last Name*</label><input id="last_name" name="last_name" required />
            <label for="email">Email*</label><input id="email" name="email" type="email" required />
            <div class="iti">
              <ul class="iti__country-list" role="listbox" style="display:none">
                <li role="option" class="iti__country">Afghanistan +93</li>
                <li role="option" class="iti__country">United States +1</li>
              </ul>
              <label for="phone">Phone</label><input id="phone" name="phone" type="tel" />
            </div>
            <div class="select__control" onclick="document.getElementById('gh-country-menu').style.display='block'">
              <label for="country">Country*</label>
              <input id="country" class="select__input" role="combobox" aria-label="Country" style="width:3px" oninput="document.getElementById('gh-country-menu').style.display='block'" />
            </div>
            <div id="gh-country-menu" role="listbox" style="display:none">
              <div id="react-select-country-option-0" class="select__option" role="option" onclick="document.getElementById('country').value='United States +1'; document.getElementById('gh-country-val').value='United States +1'; document.getElementById('gh-country-menu').style.display='none'">United States +1</div>
              <div id="react-select-country-option-1" class="select__option" role="option" onclick="document.getElementById('country').value='United States Minor Outlying Islands +1'; document.getElementById('gh-country-val').value='UM'; document.getElementById('gh-country-menu').style.display='none'">United States Minor Outlying Islands +1</div>
            </div>
            <input id="gh-country-val" type="hidden" value="" />
            <div class="file-upload-group">
              <div>Resume/CV*</div>
              <label for="resume">Attach</label>
              <input id="resume" name="resume" type="file" style="display:none" onchange="document.getElementById('resume-fn').textContent = this.files[0]?.name || ''" />
              <span id="resume-fn"></span>
            </div>
            <div class="file-upload-group">
              <div>Cover Letter</div>
              <label for="cover_letter">Attach</label>
              <input id="cover_letter" name="cover_letter" type="file" style="display:none" onchange="document.getElementById('cl-fn').textContent = this.files[0]?.name || ''" />
              <span id="cl-fn"></span>
            </div>
            <div id="late-field-wrap" style="display:none">
              <label for="late_school">University Name*</label>
              <input id="late_school" name="late_school" aria-invalid="true" required />
            </div>
            <button type="submit">Submit application</button>
          </form>
          <div id="done" style="display:none">Thank you for applying! Confirmation: GH-44210</div>
          <script>
            let tries = 0;
            document.getElementById('gh-form').addEventListener('submit', function(e) {
              e.preventDefault();
              tries += 1;
              if (document.getElementById('gh-country-val').value !== 'United States +1') {
                document.getElementById('country').setAttribute('aria-invalid', 'true');
                return;
              }
              if (tries === 1) {
                document.getElementById('late-field-wrap').style.display = 'block';
                return;
              }
              if (!document.getElementById('late_school').value.trim()) return;
              if (!document.getElementById('cl-fn').textContent.includes('Cover')) return;
              document.getElementById('gh-form').style.display = 'none';
              document.getElementById('done').style.display = 'block';
            });
          </script>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/ashby-yesno-invisible-recaptcha") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <iframe src="https://www.google.com/recaptcha/enterprise/anchor?size=invisible" width="256" height="60" style="visibility:hidden"></iframe>
          <form id="ash-form" onsubmit="event.preventDefault(); if (window.__authAnswer === 'Yes') { document.getElementById('done').style.display='block'; }">
            <label for="name">Full Name*</label><input id="name" name="name" required />
            <label for="email">Email*</label><input id="email" name="email" type="email" required />
            <div class="ashby-field">
              <label>Are you authorized to work in the United States?</label>
              <div class="yesno-group">
                <button type="button" onclick="window.__authAnswer='Yes'; this.setAttribute('aria-pressed','true')">Yes</button>
                <button type="button" onclick="window.__authAnswer='No'; this.setAttribute('aria-pressed','true')">No</button>
              </div>
            </div>
            <button type="submit">Submit Application</button>
          </form>
          <div id="done" style="display:none">Thank you for applying! Confirmation: ASH-88310</div>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/rippling-stray-combobox") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <main>
            <div class="overview">
              <input role="combobox" aria-label="Filter locations" placeholder="Location" />
              <h1>Software Engineering Intern</h1>
              <button type="button" onclick="document.querySelector('.overview').style.display='none'; document.getElementById('rip-form').style.display='block'">Apply now</button>
            </div>
            <form id="rip-form" style="display:none" onsubmit="event.preventDefault(); document.getElementById('done').style.display='block'">
              <label for="fn">First Name*</label><input id="fn" name="first_name" required />
              <label for="ln">Last Name*</label><input id="ln" name="last_name" required />
              <label for="em">Email*</label><input id="em" name="email" type="email" required />
              <button type="button" onclick="document.getElementById('rip-form').requestSubmit()">Apply</button>
            </form>
            <div id="done" style="display:none">Thank you! Application submitted. Confirmation: RIP-55190</div>
          </main>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/workday-listbox") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <form id="wd-form" onsubmit="event.preventDefault(); if (window.__wdCountry === 'United States') { document.getElementById('done').style.display='block'; }">
            <label for="wd-fn">First Name</label><input id="wd-fn" name="firstName" required />
            <label for="wd-em">Email</label><input id="wd-em" name="email" type="email" required />
            <div>
              <label for="wd-country-btn">Country</label>
              <button id="wd-country-btn" type="button" aria-haspopup="listbox" aria-label="Country" onclick="document.getElementById('wd-menu').style.display='block'">Select One</button>
              <div id="wd-menu" role="listbox" style="display:none">
                <div data-automation-id="promptOption" role="option" onclick="window.__wdCountry='United States'; document.getElementById('wd-country-btn').textContent='United States'; document.getElementById('wd-menu').style.display='none'">United States</div>
                <div data-automation-id="promptOption" role="option" onclick="window.__wdCountry='Canada'; document.getElementById('wd-country-btn').textContent='Canada'; document.getElementById('wd-menu').style.display='none'">Canada</div>
              </div>
            </div>
            <button data-automation-id="bottom-navigation-next-button" type="submit">Submit</button>
          </form>
          <div id="done" style="display:none">Application submitted! Confirmation: WD-90122</div>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/icims-outer") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <iframe id="icims_content_iframe" src="${baseUrl}/mock-inline/icims-inner"></iframe>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/icims-inner") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <form onsubmit="event.preventDefault(); document.getElementById('done').style.display='block'">
            <label for="ic-name">Full Name</label><input id="ic-name" name="name" required />
            <label for="ic-email">Email</label><input id="ic-email" name="email" type="email" required />
            <button type="submit">Submit Application</button>
          </form>
          <div id="done" style="display:none">Thank you for applying! Confirmation: ICIMS-31415</div>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/smartrecruiters-landing") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <h1>Hardware Intern</h1>
          <a href="${baseUrl}/mock-inline/smartrecruiters-oneclick">I'm interested</a>
        </body></html>`);
        return;
      }
      if (reqPath === "/mock-inline/smartrecruiters-oneclick") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<html><body>
          <div id="sr-host"></div>
          <div id="done" style="display:none">Thank you! Application submitted. Confirmation: SR-77001</div>
          <script>
            const shadow = document.getElementById('sr-host').attachShadow({ mode: 'open' });
            shadow.innerHTML = '<form id="sr-form"><label for="s-fn">First Name</label><input id="s-fn" name="firstName" required /><label for="s-em">Email</label><input id="s-em" name="email" type="email" required /><button type="submit">Submit Application</button></form>';
            shadow.getElementById('sr-form').addEventListener('submit', (e) => {
              e.preventDefault();
              document.getElementById('done').style.display = 'block';
            });
          </script>
        </body></html>`);
        return;
      }
      if (!reqPath.startsWith("/mock-ats/")) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const file = path.join(process.cwd(), "public", reqPath.slice(1));
      try {
        const html = await readFile(file, "utf8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
      } catch {
        res.statusCode = 404;
        res.end("Missing fixture");
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (typeof addr === "object" && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path.join(process.cwd(), tmpRunRoot), { recursive: true, force: true }).catch(() => undefined);
  });

  // The first Chromium launch on a shared runner precedes navigation, which
  // itself has a 25-second deadline in runPlaywrightApplication.
  it("fills, uploads PDF, submits, and verifies confirmation on mock Lever", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-ats/lever-autosubmit.html`,
      "lever",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Samira_Pilot_Resume.pdf" },
      path.join(tmpRunRoot, "lever"),
    );

    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("LEV-83921");
    expect(outcome?.fieldsResolved).toBeGreaterThanOrEqual(5);
    expect(outcome?.screenshotPath).toContain("submitted-confirmation.png");
  }, 45_000);

  it("navigates Workday multi-step Step 1 -> Save and Continue -> Step 2 -> submits", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-ats/workday-multistep.html`,
      "workday",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Samira_Pilot_Resume.pdf" },
      path.join(tmpRunRoot, "workday"),
    );

    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("WD-77410");
  }, 20_000);

  it("completes EEO dropdowns and terms checkboxes autonomously without needs_user_action", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const eeoCompleted = await runPlaywrightApplication(
      `${baseUrl}/mock-ats/ashby-eeo-stop.html`,
      "ashby",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Samira_Pilot_Resume.pdf" },
      path.join(tmpRunRoot, "eeo"),
    );
    expect(eeoCompleted).not.toBeNull();
    expect(eeoCompleted?.status).not.toBe("needs_user_action");
    expect(eeoCompleted?.answers["Gender (voluntary self-identification)"]).toBe("Decline to self-identify");
    expect(eeoCompleted?.fieldsResolved).toBeGreaterThanOrEqual(4);

    const termsCompleted = await runPlaywrightApplication(
      `${baseUrl}/mock-ats/taleo-terms-stop.html`,
      "taleo",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Samira_Pilot_Resume.pdf" },
      path.join(tmpRunRoot, "taleo-terms"),
    );
    expect(termsCompleted).not.toBeNull();
    expect(termsCompleted?.status).not.toBe("needs_user_action");
    expect(termsCompleted?.fieldsResolved).toBeGreaterThanOrEqual(4);

    const dropdownCompleted = await runPlaywrightApplication(
      `${baseUrl}/mock-ats/generic-custom-dropdown.html`,
      "unknown",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Samira_Pilot_Resume.pdf" },
      path.join(tmpRunRoot, "custom-dropdown"),
    );
    expect(dropdownCompleted).not.toBeNull();
    expect(dropdownCompleted?.status).not.toBe("needs_user_action");
    expect(dropdownCompleted?.fieldsResolved).toBeGreaterThanOrEqual(4);

    const captchaPrepared = await runPlaywrightApplication(
      `${baseUrl}/mock-ats/ashby-captcha.html`,
      "ashby",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Samira_Pilot_Resume.pdf" },
      path.join(tmpRunRoot, "captcha"),
    );
    expect(captchaPrepared).not.toBeNull();
    expect(captchaPrepared?.status).toBe("filled");
    expect(captchaPrepared?.screenshotPath).toContain("prepared-captcha-step1.png");
  }, 30_000);

  it("stops before clicking Submit when configured in fill_to_submit mode", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const filled = await runPlaywrightApplication(
      `${baseUrl}/mock-ats/lever-autosubmit.html`,
      "lever",
      makeTestContext({ mode: "fill_to_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Samira_Pilot_Resume.pdf" },
      path.join(tmpRunRoot, "fill-only"),
    );

    expect(filled?.status).toBe("filled");
    expect(filled?.confirmationNumber).toBeUndefined();
    expect(filled?.screenshotPath).toContain("filled-review.png");
  }, 20_000);

  it("classifies HTTP 403 portals as failed instead of Prepared", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/403`,
      "unknown",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Samira_Pilot_Resume.pdf" },
      path.join(tmpRunRoot, "blocked-403"),
    );

    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toMatch(/403/);
  }, 20_000);

  it("ignores header/footer search controls, clicks Apply now, attaches hidden resume input, and submits", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/footer-search-and-apply`,
      "unknown",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Molhm_Alasri_Resume.pdf" },
      path.join(tmpRunRoot, "rippling-like"),
    );

    expect(outcome?.status).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("RIP-99123");
    expect(outcome?.answers["Add Resume"] ?? outcome?.answers["Resume"]).toBe("Molhm_Alasri_Resume.pdf");
    expect(outcome?.answers).not.toHaveProperty("Search by Keyword");
  }, 20_000);

  it("creates portal accounts using configured portalPassword (Molhmiscool21!) and records verification email sent", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const ctx = makeTestContext({ mode: "auto_submit" });
    ctx.profile.email = "molhmalasri7@gmail.com";
    ctx.profile.portalPassword = "Molhmiscool21!";

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/portal-account`,
      "workday",
      ctx,
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Molhm_Alasri_Resume.pdf" },
      path.join(tmpRunRoot, "portal-account"),
    );

    expect(outcome?.status).toBe("filled");
    expect(outcome?.stages.some((s) => s.stage === "PORTAL_VERIFICATION_EMAIL_SENT")).toBe(true);
    expect(outcome?.detail).toContain("molhmalasri7@gmail.com");
  }, 20_000);

  it("completes Eightfold Create an account + AI-insights radio + Microsoft OAuth popup + form submit", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const ctx = makeTestContext({ mode: "auto_submit" });
    ctx.company = "Microsoft";
    ctx.profile.email = "molhmalasri7@gmail.com";
    ctx.profile.portalPassword = "Molhmiscool21!";

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/eightfold-ms`,
      "unknown",
      ctx,
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Molhm_Alasri_Resume.pdf" },
      path.join(tmpRunRoot, "eightfold-ms"),
    );

    expect(outcome?.status).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("MS-55210");
    expect(outcome?.stages.some((s) => s.stage === "PORTAL_ACCOUNT_SIGNUP_STARTED")).toBe(true);
    expect(outcome?.stages.some((s) => s.stage === "PORTAL_SSO_OPENED")).toBe(true);
  }, 25_000);

  it("handles Greenhouse React-Select with hidden iti__country options, cover_letter Attach input, and post-submit validation recovery", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/greenhouse-combobox-and-recovery`,
      "greenhouse",
      makeTestContext({ mode: "auto_submit" }),
      {},
      {
        resumeBytes: mockPdfBytes,
        resumeFilename: "Molhm_Alasri_Resume.pdf",
        coverLetterBytes: mockPdfBytes,
        coverLetterFilename: "Molhm_Alasri_Cover_Letter.pdf",
      },
      path.join(tmpRunRoot, "gh-combobox"),
    );

    expect(
      outcome?.status,
      JSON.stringify({ detail: outcome?.detail, answers: outcome?.answers, stages: outcome?.stages }),
    ).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("GH-44210");
    expect(outcome?.answers["Cover Letter"]).toBe("Molhm_Alasri_Cover_Letter.pdf");
    expect(outcome?.stages.some((s) => s.stage === "POST_SUBMIT_VALIDATION_RECOVERY_1")).toBe(true);
  }, 25_000);

  it("clicks Ashby Yes/No toggle buttons and ignores invisible reCAPTCHA Enterprise", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/ashby-yesno-invisible-recaptcha`,
      "ashby",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Molhm_Alasri_Resume.pdf" },
      path.join(tmpRunRoot, "ashby-yesno"),
    );

    expect(outcome?.status).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("ASH-88310");
  }, 20_000);

  it("clicks Apply now past stray Rippling search combobox and submits via Apply button", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/rippling-stray-combobox`,
      "unknown",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Molhm_Alasri_Resume.pdf" },
      path.join(tmpRunRoot, "rippling-stray"),
    );

    expect(
      outcome?.status,
      JSON.stringify({ detail: outcome?.detail, answers: outcome?.answers, stages: outcome?.stages }),
    ).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("RIP-55190");
  }, 20_000);

  it("opens and selects Workday button[aria-haspopup=listbox] dropdown and submits", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/workday-listbox`,
      "workday",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Molhm_Alasri_Resume.pdf" },
      path.join(tmpRunRoot, "wd-listbox"),
    );

    expect(outcome?.status).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("WD-90122");
  }, 20_000);

  it("unwraps iCIMS #icims_content_iframe into main frame and submits", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/icims-outer`,
      "icims",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Molhm_Alasri_Resume.pdf" },
      path.join(tmpRunRoot, "icims-iframe"),
    );

    expect(outcome?.status).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("ICIMS-31415");
    expect(outcome?.stages.some((s) => s.stage === "ICIMS_IFRAME_UNWRAPPED")).toBe(true);
  }, 20_000);

  it("clicks SmartRecruiters I'm interested and fills open Shadow DOM form to submit", async () => {
    const exe = await resolveChromiumExecutablePath();
    if (!exe) return;

    const outcome = await runPlaywrightApplication(
      `${baseUrl}/mock-inline/smartrecruiters-landing`,
      "smartrecruiters",
      makeTestContext({ mode: "auto_submit" }),
      {},
      { resumeBytes: mockPdfBytes, resumeFilename: "Molhm_Alasri_Resume.pdf" },
      path.join(tmpRunRoot, "sr-shadow"),
    );

    expect(outcome?.status).toBe("submitted");
    expect(outcome?.confirmationNumber).toBe("SR-77001");
  }, 20_000);
});
