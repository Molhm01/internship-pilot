import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page, type Response } from "playwright";

import {
  assertVisualIntegrity,
  type VisualSnapshot,
  type VisualViolation,
} from "@/lib/runtime/visualIntegrity";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const EMAIL = `publish-audit-${Date.now()}@example.com`;
const PASSWORD = "AuditPassword!2026";
const SCREENSHOT_DIR = process.env.BROWSER_SMOKE_ARTIFACTS ?? path.join(process.cwd(), "browser-smoke-artifacts");

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
  const onResponse = (response: Response) => {
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

// ---------------------------------------------------------------------------
// Visual / asset integrity
// ---------------------------------------------------------------------------

/**
 * The gate that the previous smoke did not have.
 *
 * A real Windows run served HTML whose stylesheet and JS chunks all failed:
 * the routes were not 404, not 500, and threw no page exception, so every
 * existing assertion passed while the page itself was unusable — bulleted
 * default-blue links where the sidebar should be, and a product mark filling
 * the screen. What separates that page from a working one is (a) whether its
 * own assets loaded and (b) what the browser actually computed for the
 * elements that carry the layout. Both are checked here.
 */

type RouteLandmark = { name: string; selector: string; text?: string };

const VISUAL_ROUTES: { route: string; expectSidebar: boolean; landmarks: RouteLandmark[] }[] = [
  { route: "/", expectSidebar: false, landmarks: [{ name: "public header", selector: "header" }] },
  { route: "/login", expectSidebar: false, landmarks: [{ name: "sign-in form", selector: "#auth-email" }] },
  { route: "/signup", expectSidebar: false, landmarks: [{ name: "sign-up form", selector: "#auth-password" }] },
  { route: "/dashboard", expectSidebar: true, landmarks: [] },
  {
    route: "/jobs",
    expectSidebar: true,
    landmarks: [
      { name: "Discover heading", selector: "h1", text: "Discover" },
      { name: "job feed toolbar", selector: '[data-testid="jobs-sort"]' },
    ],
  },
];

type AssetFailure = { status: number; url: string; type: string };

/** Same-origin resources whose failure genuinely breaks rendering. */
function isRequiredAsset(response: Response): boolean {
  if (!response.url().startsWith(BASE_URL)) return false;
  const type = response.request().resourceType();
  if (type === "stylesheet" || type === "script" || type === "font") return true;
  // Next emits its CSS as `document`-typed navigations in some preload paths,
  // so fall back to the path shape for anything under the build output.
  return new URL(response.url()).pathname.startsWith("/_next/static/");
}

function measurementScript(expectSidebar: boolean): string {
  return `(() => {
    var px = function (value) { return parseFloat(value) || 0; };
    var box = function (element) {
      if (!element) return null;
      var rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    var bodyStyle = getComputedStyle(document.body);
    var sidebarEl = ${expectSidebar ? 'document.querySelector("aside")' : "null"};
    var navListEl = document.querySelector('nav[aria-label="Main"] ul');
    var navLinkEl = document.querySelector('nav[aria-label="Main"] a');
    // The shell renders a hidden mobile header as well as the desktop sidebar,
    // so the FIRST matching mark can measure 0x0 and make the size assertion
    // vacuously true. Take the first candidate the browser actually painted.
    var logoCandidates = [].slice.call(
      document.querySelectorAll('aside a[aria-label="Internship Pilot"] svg, header svg, aside svg')
    );
    var logoEl = null;
    for (var i = 0; i < logoCandidates.length; i++) {
      var candidateBox = box(logoCandidates[i]);
      if (candidateBox && candidateBox.width > 0 && candidateBox.height > 0) {
        logoEl = logoCandidates[i];
        break;
      }
    }
    var mainEl = document.getElementById("main");
    var navLinkStyle = navLinkEl ? getComputedStyle(navLinkEl) : null;

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      body: {
        fontFamily: bodyStyle.fontFamily,
        backgroundColor: bodyStyle.backgroundColor,
        color: bodyStyle.color,
        marginTop: px(bodyStyle.marginTop),
        marginLeft: px(bodyStyle.marginLeft)
      },
      sidebar: sidebarEl
        ? { display: getComputedStyle(sidebarEl).display, box: box(sidebarEl) }
        : null,
      navList: navListEl ? { listStyleType: getComputedStyle(navListEl).listStyleType } : null,
      navLink: navLinkStyle
        ? {
            color: navLinkStyle.color,
            textDecorationLine: navLinkStyle.textDecorationLine,
            display: navLinkStyle.display
          }
        : null,
      logo: box(logoEl),
      main: mainEl
        ? {
            present: true,
            visible: mainEl.getBoundingClientRect().height > 0 && getComputedStyle(mainEl).display !== "none",
            box: box(mainEl)
          }
        : { present: false, visible: false, box: { width: 0, height: 0 } }
    };
  })()`;
}

async function captureSnapshot(
  page: Page,
  route: string,
  expectSidebar: boolean,
  landmarks: RouteLandmark[],
): Promise<VisualSnapshot> {
  const landmarkResults: VisualSnapshot["landmarks"] = [];
  for (const landmark of landmarks) {
    const locator = landmark.text
      ? page.locator(landmark.selector).filter({ hasText: landmark.text }).first()
      : page.locator(landmark.selector).first();
    const visible = await locator.isVisible().catch(() => false);
    landmarkResults.push({ name: landmark.name, visible });
  }

  // Passed as source text rather than as a function on purpose. This script is
  // executed through tsx, whose esbuild transform rewrites named functions to
  // call an injected `__name` helper — which does not exist in the page, so a
  // function-valued page.evaluate fails with "ReferenceError: __name is not
  // defined" before it measures anything. A string is handed to the browser
  // verbatim.
  const measured = (await page.evaluate(measurementScript(expectSidebar))) as Omit<
    VisualSnapshot,
    "route" | "landmarks"
  >;

  return { route, ...measured, landmarks: landmarkResults };
}

async function saveScreenshot(page: Page, route: string): Promise<string | null> {
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const name = `${route === "/" ? "root" : route.replace(/^\//, "").replace(/\//g, "-")}.png`;
    const file = path.join(SCREENSHOT_DIR, name);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch (error) {
    warnings.push(`Could not save a screenshot for ${route}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function visualSmoke(
  page: Page,
  entry: { route: string; expectSidebar: boolean; landmarks: RouteLandmark[] },
) {
  const { route, expectSidebar, landmarks } = entry;
  const assetFailures: AssetFailure[] = [];
  const pageErrors: string[] = [];

  const onResponse = (response: Response) => {
    const status = response.status();
    if ((status === 404 || status >= 500) && isRequiredAsset(response)) {
      assetFailures.push({ status, url: response.url(), type: response.request().resourceType() });
    }
  };
  const onRequestFailed = (request: import("playwright").Request) => {
    const type = request.resourceType();
    if (!request.url().startsWith(BASE_URL)) return;
    if (type !== "stylesheet" && type !== "script" && type !== "font") return;
    assetFailures.push({ status: 0, url: request.url(), type });
  };
  const onPageError = (error: Error) => pageErrors.push(error.message);

  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("pageerror", onPageError);

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

    if (assetFailures.length > 0) {
      const sample = assetFailures
        .slice(0, 5)
        .map((failure) => `${failure.status || "request failed"} ${failure.type} ${failure.url}`)
        .join(" | ");
      fail(`assets ${route}`, `${assetFailures.length} same-origin asset(s) did not load: ${sample}`);
      await saveScreenshot(page, route);
    } else {
      pass(`assets ${route}`, "every same-origin stylesheet, script and Next chunk loaded");
    }

    if (pageErrors.length > 0) {
      fail(`assets ${route}`, `unhandled browser error(s): ${pageErrors.join(" | ")}`);
    }

    const snapshot = await captureSnapshot(page, route, expectSidebar, landmarks);
    const violations: VisualViolation[] = assertVisualIntegrity(snapshot);
    if (violations.length > 0) {
      const file = await saveScreenshot(page, route);
      for (const violation of violations) {
        fail(`visual ${route}`, `${violation.check}: ${violation.detail}`);
      }
      if (file) console.error(`  screenshot: ${file}`);
      console.error(`  measured: ${JSON.stringify(snapshot)}`);
    } else {
      pass(
        `visual ${route}`,
        `styled correctly (font=${snapshot.body.fontFamily.split(",")[0]}, background=${snapshot.body.backgroundColor}` +
          `${snapshot.sidebar ? `, sidebar=${Math.round(snapshot.sidebar.box.width)}px` : ""}` +
          `${snapshot.logo ? `, logo=${Math.round(snapshot.logo.width)}×${Math.round(snapshot.logo.height)}px` : ""})`,
      );
    }
  } catch (error) {
    await saveScreenshot(page, route);
    fail(`visual ${route}`, error instanceof Error ? error.message : String(error));
  } finally {
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
    page.off("pageerror", onPageError);
  }
}

/**
 * Fill in, Save, and reload /profile/application — the exact regression that
 * would have caught the field-persistence incident this check exists for: a
 * UI reporting "Saved" while several displayed fields were silently
 * discarded. Synthetic CI values only, never real identity.
 */
async function profileSaveRegression(page: Page) {
  const area = "profile save regression";
  try {
    await page.goto(`${BASE_URL}/profile/application`, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const legalFirstName = "Audit";
    const legalLastName = "Fixture";
    const applicationEmail = `audit-fixture-${Date.now()}@example.test`;
    const school = "Audit Fixture University";

    await page.locator('input[name="legalFirstName"]').fill(legalFirstName);
    await page.locator('input[name="legalLastName"]').fill(legalLastName);
    await page.locator('input[name="applicationEmail"]').fill(applicationEmail);
    await page.locator('input[name="school"]').fill(school);
    await page.locator('input[name="major"]').fill("Audit Studies");
    await page.locator('select[name="legallyAuthorizedToWork"]').selectOption("yes");
    await page.locator('input[name="eeoGender"]').fill("Audit answer");

    await page.getByRole("button", { name: /Save profile|Saving…/ }).click();
    await page.getByText("Saved.", { exact: true }).waitFor({ timeout: 15_000 });

    // A visible error after clicking Save is exactly what the client-side
    // round-trip check (CanonicalProfileForm.tsx) should have surfaced
    // instead, if it had one — this asserts it did not.
    const errorVisible = await page.getByText(/could not be saved|Save did not take effect/i).isVisible().catch(() => false);
    if (errorVisible) {
      fail(area, "an error message was visible alongside a reported Saved state");
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('input[name="legalFirstName"]').waitFor({ state: "visible", timeout: 15_000 });

    const reloadedFirstName = await page.locator('input[name="legalFirstName"]').inputValue();
    const reloadedLastName = await page.locator('input[name="legalLastName"]').inputValue();
    const reloadedEmail = await page.locator('input[name="applicationEmail"]').inputValue();
    const reloadedSchool = await page.locator('input[name="school"]').inputValue();
    const reloadedMajor = await page.locator('input[name="major"]').inputValue();
    const reloadedAuth = await page.locator('select[name="legallyAuthorizedToWork"]').inputValue();
    const reloadedGender = await page.locator('input[name="eeoGender"]').inputValue();

    const checks: Array<[string, string, string]> = [
      ["legalFirstName", legalFirstName, reloadedFirstName],
      ["legalLastName", legalLastName, reloadedLastName],
      ["applicationEmail", applicationEmail, reloadedEmail],
      ["school", school, reloadedSchool],
      ["major", "Audit Studies", reloadedMajor],
      ["legallyAuthorizedToWork", "yes", reloadedAuth],
      ["eeoGender", "Audit answer", reloadedGender],
    ];
    const mismatches = checks.filter(([, expected, actual]) => expected !== actual);
    if (mismatches.length > 0) {
      fail(
        area,
        `after reload, fields did not retain their saved value: ${mismatches.map(([name, expected, actual]) => `${name} (expected "${expected}", got "${actual}")`).join("; ")}`,
      );
    } else {
      pass(area, "fill → Save → reload retained every checked field, across UserProfile, ApplicationPreferences, Education, and SensitiveAnswerPreferences");
    }
  } catch (error) {
    fail(area, error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    // Public root is a release-critical route: a visitor opening the domain
    // should never land on Next.js's bare 404 page.
    await routeSmoke(page, "/");

    // Unauthenticated visual gates first: /login and /signup redirect to the
    // dashboard once a session exists.
    for (const entry of VISUAL_ROUTES.filter((candidate) => !candidate.expectSidebar)) {
      await visualSmoke(page, entry);
    }

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

      await profileSaveRegression(page);

      // Authenticated visual gates, now that the app shell actually renders.
      for (const entry of VISUAL_ROUTES.filter((candidate) => candidate.expectSidebar)) {
        await visualSmoke(page, entry);
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
  if (failures.length > 0) console.error(`Screenshots (when captured) are in ${SCREENSHOT_DIR}`);

  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
