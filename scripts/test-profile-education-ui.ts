import "dotenv/config";
import { chromium } from "playwright";
import { prisma } from "@/lib/db";
import { assertDisposablePostgres, announceDisposableDatabase } from "./lib/disposableDatabase";

/**
 * Browser-driven regression coverage for the "Additional education" section
 * (src/components/ProfileEntriesSection.tsx), added because the profile
 * form's own copy referenced a second-education-entry UI that did not exist.
 * The backend (/api/profile/education, /api/profile/entries) already existed
 * and is exercised here exactly as a user would: through the real page.
 */

const FIXTURE = "Profile education UI regression";
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const PASSWORD = "Correct-Horse-Battery-Verify-9!";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function main() {
  const database = assertDisposablePostgres(FIXTURE);
  announceDisposableDatabase(FIXTURE, database);

  const browser = await chromium.launch({ headless: true });
  const email = `education-ui-${Date.now()}@fixture.internship-pilot.test`;

  try {
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/signup`, { waitUntil: "domcontentloaded" });
    await page.locator("#auth-name").fill("Education Regression");
    await page.locator("#auth-email").fill(email);
    await page.locator("#auth-password").fill(PASSWORD);
    await page.locator("#auth-confirm-password").fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE_URL}/dashboard`, { timeout: 10_000 });

    await page.goto(`${BASE_URL}/profile/application`, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="school"]').fill("Primary Verification University");
    await page.locator('input[name="degreeType"]').fill("B.S. Computer Science");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.waitForTimeout(800);

    console.log("1) Add an additional education entry");
    // Matched by its own <h2>, not a text substring — the Application profile
    // form's own Education section hint text also mentions "Additional
    // education", so a plain hasText filter on <section> would match both.
    const additionalSection = page.locator("section").filter({ has: page.locator("h2", { hasText: "Additional education" }) });
    // Fill the blank text inputs in the "add" editor by field order.
    const addForm = additionalSection.locator("form").last();
    await addForm.locator('input').nth(0).fill("Secondary Regression College"); // school
    await addForm.locator('input').nth(1).fill("Associate's"); // degree
    await addForm.locator('input').nth(2).fill("General Studies"); // major
    await addForm.getByRole("button", { name: "Add" }).click();
    await page.waitForTimeout(1000);

    const entries = additionalSection.locator("form");
    const entryCountAfterAdd = await entries.count();
    check(entryCountAfterAdd === 2, `entry appears in the list plus a fresh blank "add" form (got ${entryCountAfterAdd} forms)`);

    const savedEntryText = await entries.nth(0).locator('input').nth(0).inputValue();
    check(savedEntryText === "Secondary Regression College", `saved entry shows the school just entered (got "${savedEntryText}")`);

    console.log("2) Edit the entry");
    await entries.nth(0).locator('input').nth(1).fill("Bachelor's (transferred)");
    await entries.nth(0).getByRole("button", { name: "Save" }).click();
    await page.waitForTimeout(1000);

    console.log("3) Reload and verify edit persisted");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    const reloadedSection = page.locator("section").filter({ has: page.locator("h2", { hasText: "Additional education" }) });
    const reloadedDegree = await reloadedSection.locator("form").nth(0).locator('input').nth(1).inputValue();
    check(reloadedDegree === "Bachelor's (transferred)", `edited degree persisted after reload (got "${reloadedDegree}")`);

    console.log("4) Delete the entry");
    await reloadedSection.locator("form").nth(0).getByRole("button", { name: "Remove" }).click();
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    const afterDeleteSection = page.locator("section").filter({ has: page.locator("h2", { hasText: "Additional education" }) });
    const afterDeleteFormCount = await afterDeleteSection.locator("form").count();
    check(afterDeleteFormCount === 1, `entry removed after delete + reload, only the blank add-form remains (got ${afterDeleteFormCount})`);

    console.log("5) Primary education entry (from the Application profile form) is untouched");
    await page.goto(`${BASE_URL}/profile/application`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const primarySchool = await page.locator('input[name="school"]').inputValue();
    check(primarySchool === "Primary Verification University", `primary school field is unaffected by add/edit/delete of additional entries (got "${primarySchool}")`);
  } finally {
    await browser.close();
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll profile-education-UI regression checks PASSED.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
