import "dotenv/config";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { prisma } from "@/lib/db";

const url = "https://job-boards.greenhouse.io/astranis/jobs/4681472006";
const screenshotPath = "data/generated/diagnostics/greenhouse-real-inspection.png";
async function main() {
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const result = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("label")].map((label) => label.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean) as string[];
    return { url: location.href, title: document.title, labelCount: labels.length, labels, hasName: labels.some((x) => /first name/i.test(x)), hasEmail: labels.some((x) => /^email/i.test(x)), hasPhone: labels.some((x) => /phone/i.test(x)), hasResume: Boolean(document.querySelector('input[type="file"]')), submitPresent: [...document.querySelectorAll("button,input")].some((node) => /submit application/i.test((node.textContent || node.getAttribute("value") || ""))) };
  });
  await mkdir(path.join(process.cwd(), path.dirname(screenshotPath)), { recursive: true });
  await page.screenshot({ path: path.join(process.cwd(), screenshotPath), fullPage: true });
  const report = { pass: result.hasName && result.hasEmail && result.hasPhone && result.hasResume && result.submitPresent, inspectedAt: new Date().toISOString(), enteredPersonalData: false, submitted: false, screenshotPath, ...result };
  await prisma.appSetting.upsert({ where: { key: "greenhouseRealInspection" }, update: { value: JSON.stringify(report) }, create: { key: "greenhouseRealInspection", value: JSON.stringify(report) } });
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await prisma.$disconnect(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
