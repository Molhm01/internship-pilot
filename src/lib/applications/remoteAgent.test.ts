import { describe, expect, it, vi } from "vitest";
import { inspectAndRunRemoteApplication } from "./remoteAgent";
import type { FillContext } from "./types";

function makeCtx(applyUrl: string): FillContext {
  return {
    jobId: "job-unit-1",
    runId: "run-unit-1",
    jobTitle: "Software Engineering Intern",
    company: "Acme Corp",
    applyUrl,
    mode: "auto_submit",
    profile: {
      fullName: "Jordan Pilot",
      legalFirstName: "Jordan",
      legalLastName: "Pilot",
      legalMiddleName: null,
      noMiddleName: true,
      preferredName: "Jordan Pilot",
      email: "jordan@pilot.dev",
      alternateEmail: null,
      phone: "555-010-2222",
      phoneCountryCode: "+1",
      addressStreet: "100 Main St",
      addressLine2: null,
      addressCity: "Austin",
      addressState: "TX",
      addressZip: "78701",
      countryOfResidence: "United States",
      metroRegion: "Austin",
      linkedin: "https://linkedin.com/in/jordanpilot",
      github: "https://github.com/jordanpilot",
      portfolio: "https://jordanpilot.dev",
      website: "https://jordanpilot.dev",
      school: "UT Austin",
      degreeType: "B.S.",
      educationLevel: "Bachelor's",
      major: "Computer Engineering",
      minor: null,
      gpa: "3.85",
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
    resumeFilePath: "data/generated/test.pdf",
    coverLetterFilePath: null,
    coverLetterText: "Interested in embedded engineering.",
    educationDegree: "B.S. Computer Engineering",
    recentExperience: "Hardware Systems Intern",
    approvedRunAnswers: {},
  };
}

describe("remoteAgent safety guards", () => {
  it("refuses unresolved aggregator URLs instead of filling LinkedIn/Indeed auth walls", async () => {
    const outcome = await inspectAndRunRemoteApplication(
      makeCtx("https://www.linkedin.com/jobs/view/4491540463/"),
      "user-unit-1",
      {
        resumeBytes: new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF")),
        resumeFilename: "Resume.pdf",
      },
      { atsType: "linkedin" },
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/aggregator/i);
    expect(outcome.fieldsResolved).toBe(0);
  });

  it("ignores header search forms and does not falsely mark them as submitted", async () => {
    const origDisable = process.env.DISABLE_SERVER_BROWSER_AGENT;
    process.env.DISABLE_SERVER_BROWSER_AGENT = "1";
    const fetchSpy = vi.fn(async () =>
      new Response(
        `<html><body>
          <form action="/search/" method="get">
            <label for="q">Search by Keyword</label>
            <input id="q" name="q" type="text" />
            <label for="loc">Search by Location</label>
            <input id="loc" name="locationsearch" type="text" />
            <button type="submit">Search Jobs</button>
          </form>
        </body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const outcome = await inspectAndRunRemoteApplication(
        makeCtx("https://jobs.paccar.com/job/Denton-Intern/123/?ats=successfactors"),
        "user-unit-1",
        {
          resumeBytes: new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF")),
          resumeFilename: "Resume.pdf",
        },
        { atsType: "successfactors" },
      );

      expect(outcome.status).not.toBe("submitted");
      expect(outcome.answers).not.toHaveProperty("Search by Keyword");
    } finally {
      vi.unstubAllGlobals();
      if (origDisable === undefined) delete process.env.DISABLE_SERVER_BROWSER_AGENT;
      else process.env.DISABLE_SERVER_BROWSER_AGENT = origDisable;
    }
  });
});
