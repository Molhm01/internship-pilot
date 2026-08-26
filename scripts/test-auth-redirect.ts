import "dotenv/config";
import { chromium } from "playwright";
import { prisma } from "@/lib/db";
import { assertDisposablePostgres, announceDisposableDatabase } from "./lib/disposableDatabase";

/**
 * Regression coverage for the signup/login post-auth redirect.
 *
 * AuthForm used to call router.push("/dashboard") immediately followed by
 * router.refresh(). Under real network latency (signup's create-account
 * round trip is slower than login's) refresh() sometimes raced push() and
 * re-fetched the auth page itself instead of the destination, leaving a
 * successfully authenticated user stranded on the signup/login form with no
 * visible confirmation. The fix removed the redundant refresh(); this test
 * proves the redirect lands reliably across many consecutive cycles rather
 * than trusting one lucky run.
 *
 * This talks to a REAL running Next server over a REAL browser (Playwright),
 * the same way scripts/test-application-agent.ts drives the application
 * worker — no mocking of router internals, because the bug was in the
 * actual client-side navigation timing.
 *
 * Every cycle gets its own browser CONTEXT (not just a new page/tab): pages
 * sharing one context share one cookie jar, so account N's session cookie
 * would leak into account N+1's signup/login and produce exactly the kind
 * of flaky, hard-to-attribute failure this test exists to rule out. A real
 * new signup always starts from a browser with no prior session.
 */

const FIXTURE = "Auth redirect regression";
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const PASSWORD = "Correct-Horse-Battery-Verify-9!";
const CYCLES = Number(process.env.AUTH_REDIRECT_CYCLES ?? 10);

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function main() {
  const database = assertDisposablePostgres(FIXTURE);
  announceDisposableDatabase(FIXTURE, database);

  const browser = await chromium.launch({ headless: true });
  const createdEmails: string[] = [];

  try {
    console.log(`1) Signup redirect: ${CYCLES} consecutive cycles`);
    for (let i = 0; i < CYCLES; i++) {
      // Paced, not fired back-to-back: Better Auth's default rate limiter
      // returns 429 (confirmed via its own `x-retry-after: 10` header) on a
      // rapid run of signups/logins from one IP — a real, separate, correct
      // security feature, not the redirect bug this test targets. A 429 must
      // not be misread as a redirect failure, so cycles are spaced past the
      // limiter's 10-second window instead.
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 15_000));
      const context = await browser.newContext();
      const page = await context.newPage();
      const responses: string[] = [];
      page.on("response", (r) => {
        if (r.url().includes("/api/") || r.url().endsWith("/dashboard") || r.url().endsWith("/signup")) {
          responses.push(`${r.status()} ${r.url()}`);
        }
      });
      const email = `auth-redirect-signup-${Date.now()}-${i}@fixture.internship-pilot.test`;
      createdEmails.push(email);
      try {
        await page.goto(`${BASE_URL}/signup`, { waitUntil: "domcontentloaded" });
        await page.locator("#auth-name").fill("Redirect Regression");
        await page.locator("#auth-email").fill(email);
        await page.locator("#auth-password").fill(PASSWORD);
        await page.locator("#auth-confirm-password").fill(PASSWORD);
        await page.locator('button[type="submit"]').click();
        // Event-driven: waits for the URL to actually change, not a fixed sleep.
        await page.waitForURL(`${BASE_URL}/dashboard`, { timeout: 10_000 });
        check(true, `cycle ${i}: signup landed on /dashboard`);
      } catch (error) {
        check(false, `cycle ${i}: signup landed on /dashboard (stuck at ${page.url()}: ${error instanceof Error ? error.message : String(error)})\n    responses: ${responses.join(" | ")}`);
      } finally {
        await context.close();
      }
    }

    console.log(`2) Login redirect: ${CYCLES} consecutive cycles`);
    for (let i = 0; i < CYCLES; i++) {
      // Paced, not fired back-to-back: Better Auth's default rate limiter
      // returns 429 (confirmed via its own `x-retry-after: 10` header) on a
      // rapid run of signups/logins from one IP — a real, separate, correct
      // security feature, not the redirect bug this test targets. A 429 must
      // not be misread as a redirect failure, so cycles are spaced past the
      // limiter's 10-second window instead.
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 15_000));
      const context = await browser.newContext();
      const page = await context.newPage();
      const email = createdEmails[i]!;
      try {
        await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
        await page.locator("#auth-email").fill(email);
        await page.locator("#auth-password").fill(PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(`${BASE_URL}/dashboard`, { timeout: 10_000 });
        check(true, `cycle ${i}: login landed on /dashboard`);
      } catch (error) {
        check(false, `cycle ${i}: login landed on /dashboard (stuck at ${page.url()}: ${error instanceof Error ? error.message : String(error)})`);
      } finally {
        await context.close();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 15_000));
    console.log("3) Login honors an explicit ?next= redirect target");
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      const email = createdEmails[0]!;
      try {
        await page.goto(`${BASE_URL}/profile`, { waitUntil: "domcontentloaded" });
        check(page.url().startsWith(`${BASE_URL}/login?next=`), "unauthenticated visit to /profile redirects to /login?next=...");
        await page.locator("#auth-email").fill(email);
        await page.locator("#auth-password").fill(PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(`${BASE_URL}/profile`, { timeout: 10_000 });
        check(true, "login redirected to the original ?next= destination, not just /dashboard");
      } catch (error) {
        check(false, `login honored ?next= (stuck at ${page.url()}: ${error instanceof Error ? error.message : String(error)})`);
      } finally {
        await context.close();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 15_000));
    console.log("4) Wrong password still rejected with an inline error (unchanged behavior)");
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      const email = createdEmails[0]!;
      try {
        await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
        await page.locator("#auth-email").fill(email);
        await page.locator("#auth-password").fill("definitely-the-wrong-password");
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(1000);
        const bodyText = await page.locator("body").innerText();
        check(page.url().includes("/login") && /invalid|incorrect|does not match|failed/i.test(bodyText), "wrong password stays on /login with a visible error");
      } finally {
        await context.close();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 15_000));
    console.log("5) Logout still clears the session (unchanged behavior)");
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      const responses: string[] = [];
      page.on("response", (r) => {
        if (r.url().includes("/api/")) responses.push(`${r.status()} ${r.url()}`);
      });
      const email = createdEmails[0]!;
      try {
        await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
        await page.locator("#auth-email").fill(email);
        await page.locator("#auth-password").fill(PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(`${BASE_URL}/dashboard`, { timeout: 10_000 });
        await page.goto(`${BASE_URL}/logout`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(500);
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
        check(page.url().startsWith(`${BASE_URL}/login`), `logout clears the session; /dashboard redirects to /login again (url=${page.url()}, responses: ${responses.join(" | ")})`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await prisma.$disconnect();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll auth-redirect regression checks PASSED.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
