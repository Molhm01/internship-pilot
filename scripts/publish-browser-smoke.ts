import { chromium, type Page } from "playwright";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const EMAIL = `publish-audit-${Date.now()}@example.com`;
const PASSWORD = "AuditPassword!2026";

const authenticatedRoutes = [
  "/dashboard",
  "/jobs",
  "/tracker",
  "/documents",
  "/profile",
  "/profile/application",
  "/agent",
  "/activity",
  "/agent-diagnostics",
  "/watchlist",
  "/approved-employers",
  "/nearby",
  "/assessments",
  "/security-quarantine",
  "/settings",
  "/design-system",
] as const;

type Failure = {
  area: string;
  detail: string;
};

const failures: Failure[] = [];
const warnings: string[] = [];

function fail(area: string, detail: string) {
  failures.push({ area, detail });
  console.error(`FAIL [${area}] ${detail}`);
}

function pass(area: string, detail: string) {
  console.log(`PASS [${area}] ${detail}`);
}

async function routeSmoke(page: Page, route: string) {
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  const onResponse = (response: import("playwright").Response) => {
    if (response.status() >= 500 && response.url().startsWith(BASE_URL)) {
      serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  };

  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  try {
    const response = await page.goto(`${BASE_URL}${route}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    const status = response?.status() ?? 0;
    const body = await page.locator("body").innerText().catch(() => "");
    if (status === 404 || /This page could not be found/i.test(body)) {
      fail(`route ${route}`, `returned the Next.js 404 page (HTTP ${status || "unknown"})`);
    } else if (status >= 500) {
      fail(`route ${route}`, `returned HTTP ${status}`);
    } else if (pageErrors.length) {
      fail(`route ${route}`, `browser exception(s): ${pageErrors.join(" | ")}`);
    } else if (serverErrors.length) {
      fail(`route ${route}`, `internal API/server error(s): ${serverErrors.join(" | ")}`);
    } else {
      pass(`route ${route}`, `rendered without 404/5xx/page exceptions (HTTP ${status || "client navigation"})`);
    }
  } catch (error) {
    fail(`route ${route}`, error instanceof Error ? error.message : String(error));
  } finally {
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Public root is a release-critical route: a visitor opening the domain
    // should never land on Next.js's bare 404 page.
    await routeSmoke(page, "/");

    const signup = await page.goto(`${BASE_URL}/signup`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!signup || signup.status() >= 400) {
      fail("auth signup", `signup page returned HTTP ${signup?.status() ?? "no response"}`);
    } else {
      await page.locator("#auth-name").fill("Publish Audit User");
      await page.locator("#auth-email").fill(EMAIL);
      await page.locator("#auth-password").fill(PASSWORD);
      await page.locator("#auth-confirm-password").fill(PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
      try {
        await page.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 20_000 });
        pass("auth signup", "email/password signup created a session and redirected to /dashboard");
      } catch {
        const body = await page.locator("body").innerText().catch(() => "");
        fail("auth signup", `did not reach /dashboard; current URL=${page.url()} body=${body.slice(0, 500)}`);
      }
    }

    if (/\/dashboard(?:\?|$)/.test(page.url())) {
      for (const route of authenticatedRoutes) {
        await routeSmoke(page, route);
      }

      // Sign out through the product route, then prove the same credentials can
      // establish a fresh session again.
      try {
        await page.goto(`${BASE_URL}/logout`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForURL(/\/login(?:\?|$)/, { timeout: 15_000 });
        pass("auth logout", "logout cleared the session and returned to /login");
      } catch (error) {
        fail("auth logout", error instanceof Error ? error.message : String(error));
      }

      try {
        await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.locator("#auth-email").fill(EMAIL);
        await page.locator("#auth-password").fill(PASSWORD);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 20_000 });
        pass("auth login", "existing account logged in and returned to /dashboard");
      } catch (error) {
        fail("auth login", error instanceof Error ? error.message : String(error));
      }
    } else {
      warnings.push("Authenticated route traversal was skipped because signup did not establish a session.");
    }
  } finally {
    await browser.close();
  }

  console.log("\n=== Browser smoke summary ===");
  console.log(`failures=${failures.length}`);
  for (const warning of warnings) console.warn(`WARN ${warning}`);
  for (const item of failures) console.error(`- ${item.area}: ${item.detail}`);

  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
