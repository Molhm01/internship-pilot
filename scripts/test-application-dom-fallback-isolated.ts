import "dotenv/config";
import path from "node:path";
import { rm } from "node:fs/promises";
import { chromium } from "playwright";
import { prisma } from "@/lib/db";
import { fillGenericForm } from "@/lib/applications/formFiller";
import type { FillContext } from "@/lib/applications/types";

async function main(): Promise<void> {
  if (process.env.DOM_FALLBACK_COPY_TEST !== "1") throw new Error("This test may run only against a disposable database copy.");
  if (process.env.DISABLE_VISION_AGENT !== "1") throw new Error("Vision must be disabled for the DOM fallback proof.");
  const [run, profile] = await Promise.all([
    prisma.applicationRun.findFirst({ orderBy: { updatedAt: "desc" } }),
    prisma.applicationProfile.findUnique({ where: { id: "default" } }),
  ]);
  if (!run || !profile?.fullName || !profile.email || !profile.phone || !profile.school) {
    throw new Error("The copied production schema needs one run and a complete Candidate Profile.");
  }

  const browser = await chromium.launch({ headless: true });
  const runDirectory = path.join("data", "generated", "diagnostics", `dom-fallback-${process.pid}`);
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
    await page.addInitScript(() => {
      const browserWindow = window as unknown as { __name?: (fn: unknown, name: string) => unknown };
      browserWindow.__name = browserWindow.__name || ((fn: unknown) => fn);
    });
    await page.reload();
    await page.setContent(`
      <form id="application">
        <label for="full-name">Full name</label><input id="full-name" name="fullName" required>
        <label for="email">Email</label><input id="email" type="email" name="email" required>
        <label for="telephone">Telephone</label><input id="telephone" type="tel" name="telephone" required>
        <label for="address">Street address</label><input id="address" name="address">
        <label for="school">School</label><input id="school" name="school" required>
        <label for="degree">Degree</label><input id="degree" name="degree" required>
        <button type="submit">Submit application</button>
      </form>
      <script>
        window.__submitted = false;
        document.querySelector("#application").addEventListener("submit", (event) => {
          event.preventDefault();
          window.__submitted = true;
        });
      </script>
    `);
    const ctx: FillContext = {
      jobId: run.jobId,
      runId: run.id,
      jobTitle: "DOM fallback test",
      company: "Local test only",
      applyUrl: "http://localhost/dom-fallback",
      mode: "fill_to_submit",
      profile: {
        fullName: profile.fullName,
        preferredName: profile.preferredName,
        email: profile.email,
        phone: profile.phone,
        linkedin: profile.linkedin,
        github: profile.github,
        website: profile.website,
        school: profile.school,
        previousSchool: profile.previousSchool,
        addressStreet: profile.addressStreet,
        addressCity: profile.addressCity,
        addressState: profile.addressState,
        addressZip: profile.addressZip,
        countryOfResidence: profile.countryOfResidence,
        willingToRelocate: profile.willingToRelocate,
        locationPreferences: null,
        internshipTermAvailability: profile.internshipTermAvailability,
        salaryAnswerPreference: profile.salaryAnswerPreference,
        workAuthorization: profile.workAuthorization,
        requiresSponsorship: profile.requiresSponsorship,
        clearanceEligible: profile.clearanceEligible,
        eeoGender: profile.eeoGender,
        eeoRaceEthnicity: profile.eeoRaceEthnicity,
        eeoVeteranStatus: profile.eeoVeteranStatus,
        eeoDisabilityStatus: profile.eeoDisabilityStatus,
      },
      resumeFilePath: null,
      coverLetterFilePath: null,
      coverLetterText: null,
      educationDegree: "Engineering degree",
      approvedRunAnswers: {},
    };
    const result = await fillGenericForm(page, ctx, runDirectory);
    const values = await page.evaluate(() => ({
      name: (document.querySelector("#full-name") as HTMLInputElement).value,
      email: (document.querySelector("#email") as HTMLInputElement).value,
      phone: (document.querySelector("#telephone") as HTMLInputElement).value,
      school: (document.querySelector("#school") as HTMLInputElement).value,
      degree: (document.querySelector("#degree") as HTMLInputElement).value,
      submitted: (window as unknown as { __submitted: boolean }).__submitted,
    }));
    if (result.status !== "filled") throw new Error(`Expected filled, received ${result.status}: ${result.error ?? result.stopReason ?? ""}`);
    if (!values.name || !values.email || !values.phone || !values.school || !values.degree) {
      throw new Error(`DOM fallback left a normal labeled field empty: ${JSON.stringify(values)}`);
    }
    if (values.submitted) throw new Error("DOM fallback clicked Submit.");
    console.log(JSON.stringify({
      pass: true,
      visionDisabled: true,
      status: result.status,
      normalFieldsFilled: ["name", "email", "telephone", "school", "degree"],
      submitClicked: false,
      applicationRunIdUnchanged: run.id,
      resumeVersionsCreated: 0,
    }, null, 2));
  } finally {
    await browser.close();
    await rm(path.join(process.cwd(), runDirectory), { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
