import "dotenv/config";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { prisma } from "@/lib/db";
import { navigateToApplicationForm } from "@/lib/applications/navigation";

const LIGHTSHIP_JOB_ID = "cmrwsl2xq008dfokuzzs7ykoy";

async function main() {
  const job = await prisma.job.findUnique({ where: { id: LIGHTSHIP_JOB_ID } });
  if (!job) throw new Error("The current Lightship job record was not found.");
  const officialApplyUrl = job.officialApplyUrl ?? job.url;
  if (!officialApplyUrl?.startsWith("https://")) throw new Error(`Lightship officialApplyUrl is invalid: ${JSON.stringify(officialApplyUrl)}.`);

  const outputDir = path.join(process.cwd(), "data", "generated", "diagnostics");
  await mkdir(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, "lever-real-navigation.png");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const inspection = await navigateToApplicationForm(page, officialApplyUrl, "lever");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const submitPresent = await page.locator('button[type="submit"], input[type="submit"], button:has-text("Submit")').count() > 0;
    const report = {
      pass: inspection.formDetected && inspection.fieldCount > 0 && /\/apply\/?(?:[?#].*)?$/i.test(inspection.finalUrl),
      inspectedAt: new Date().toISOString(),
      listingUrl: inspection.listingUrl,
      finalUrl: inspection.finalUrl,
      httpStatus: inspection.httpStatus,
      formDetected: inspection.formDetected,
      fieldCount: inspection.fieldCount,
      fields: inspection.fields,
      enteredPersonalData: false,
      uploadedFiles: false,
      submitted: false,
      submitPresent,
      screenshotPath,
    };
    await prisma.appSetting.upsert({
      where: { key: "leverRealInspection" },
      create: { key: "leverRealInspection", value: JSON.stringify(report) },
      update: { value: JSON.stringify(report) },
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exitCode = 1;
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
