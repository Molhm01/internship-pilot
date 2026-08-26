import type { Page } from "playwright";
import type { AtsType } from "./types";

export class ApplicationNavigationError extends Error {
  constructor(
    message: string,
    public readonly attemptedUrl: string,
    public readonly finalUrl: string,
    public readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "ApplicationNavigationError";
  }
}

/**
 * Thrown instead of navigating when LOCAL_DIAGNOSTIC_MODE=true and the
 * target is not a local/mock-ATS destination. Added after a local diagnostic
 * session's own "Apply" test accidentally drove the real application worker
 * to a live employer's careers site (Seagate) — LOCAL_DIAGNOSTIC_MODE is the
 * guard that makes that impossible to repeat.
 */
export class DiagnosticExternalNavigationBlockedError extends Error {
  readonly code = "diagnostic_external_navigation_blocked";
  constructor(public readonly attemptedUrl: string) {
    super(
      `diagnostic_external_navigation_blocked: LOCAL_DIAGNOSTIC_MODE is enabled and "${attemptedUrl}" is not a localhost/127.0.0.1/mock-ATS destination. The application agent will not navigate a real browser to it.`,
    );
    this.name = "DiagnosticExternalNavigationBlockedError";
  }
}

/**
 * Destinations LOCAL_DIAGNOSTIC_MODE permits: the dev server itself
 * (localhost/127.0.0.1 on any port, which is where /mock-ats/*.html and the
 * app's own pages are served) and nothing else. This is intentionally an
 * allowlist, not a denylist of known ATS domains — a denylist only blocks
 * URLs someone thought to list.
 */
function isLocalDiagnosticAllowedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:")
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  );
}

function assertNavigationAllowed(url: string): void {
  if (process.env.LOCAL_DIAGNOSTIC_MODE === "true" && !isLocalDiagnosticAllowedUrl(url)) {
    throw new DiagnosticExternalNavigationBlockedError(url);
  }
}

export type ApplicationFormInspection = {
  listingUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  formDetected: boolean;
  fieldCount: number;
  reusedExistingPage: boolean;
  fields: Array<{ label: string; type: string; required: boolean; options: string[] }>;
};

async function visibleFormFields(page: Page): Promise<ApplicationFormInspection["fields"]> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:not([type="hidden"]):not([type="submit"]), textarea, select'))
      .filter((control) => control.getClientRects().length > 0 && !control.closest('[hidden], [aria-hidden="true"]'));
    return controls.map((control) => {
      const id = control.id;
      const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : "";
      const label = explicit || control.closest("label")?.textContent?.replace(/\s+/g, " ").trim() || control.getAttribute("aria-label") || control.getAttribute("placeholder") || control.getAttribute("name") || "(Label unavailable)";
      return {
        label,
        type: control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
        required: control.required || control.getAttribute("aria-required") === "true",
        options: control instanceof HTMLSelectElement ? Array.from(control.options).map((option) => option.textContent?.trim() || "") : [],
      };
    });
  });
}

export async function navigateToApplicationForm(
  page: Page,
  officialApplyUrl: string,
  atsType: AtsType,
  onPageLoaded?: (detail: string) => Promise<void>,
): Promise<ApplicationFormInspection> {
  assertNavigationAllowed(officialApplyUrl);
  const currentUrl = page.url();
  if (currentUrl && currentUrl !== "about:blank") {
    try {
      const requested = new URL(officialApplyUrl);
      const current = new URL(currentUrl);
      const requestedPath = requested.pathname.replace(/\/+$/, "");
      const sameApplication = current.origin === requested.origin
        && (current.pathname.replace(/\/+$/, "") === requestedPath || current.pathname.startsWith(`${requestedPath}/`));
      if (sameApplication) {
        const fields = await visibleFormFields(page);
        if (fields.length > 0) {
          await onPageLoaded?.(`Reused the worker's open application page at ${currentUrl}; no navigation or new page was needed.`);
          return {
            listingUrl: officialApplyUrl,
            finalUrl: currentUrl,
            httpStatus: null,
            formDetected: true,
            fieldCount: fields.length,
            reusedExistingPage: true,
            fields,
          };
        }
      }
    } catch {
      // A malformed current page URL is not reusable; normal navigation below
      // still validates and opens the already-validated officialApplyUrl.
    }
  }

  let responseStatus: number | null = null;
  try {
    const response = await page.goto(officialApplyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    responseStatus = response?.status() ?? null;
  } catch (error) {
    throw new ApplicationNavigationError(
      `Navigation to ${officialApplyUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
      officialApplyUrl,
      page.url(),
      responseStatus,
    );
  }
  const listingUrl = page.url();
  if (!listingUrl || listingUrl === "about:blank") throw new ApplicationNavigationError("Navigation finished on about:blank.", officialApplyUrl, listingUrl, responseStatus);
  if (responseStatus !== null && responseStatus >= 400) throw new ApplicationNavigationError(`Application listing returned HTTP ${responseStatus}.`, officialApplyUrl, listingUrl, responseStatus);
  await onPageLoaded?.(`Listing loaded at ${listingUrl}${responseStatus === null ? "" : ` (HTTP ${responseStatus})`}.`);

  const fieldsOnListing = await visibleFormFields(page);
  if (atsType === "lever" && fieldsOnListing.length === 0 && !/\/apply\/?(?:[?#].*)?$/i.test(page.url())) {
    const applyLinks = page.locator('a:has-text("Apply for this job"), a.postings-btn, a[href$="/apply"]');
    let applyLink = applyLinks.first();
    let visibleApplyLinkFound = false;
    for (let index = 0; index < await applyLinks.count(); index += 1) {
      if (await applyLinks.nth(index).isVisible()) {
        applyLink = applyLinks.nth(index);
        visibleApplyLinkFound = true;
        break;
      }
    }
    if (!visibleApplyLinkFound) {
      throw new ApplicationNavigationError('Lever listing loaded, but no visible "Apply for this job" link was found.', officialApplyUrl, page.url(), responseStatus);
    }
    try {
      await applyLink.click({ timeout: 15_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 45_000 });
    } catch (error) {
      throw new ApplicationNavigationError(
        `Lever "Apply for this job" navigation failed: ${error instanceof Error ? error.message : String(error)}`,
        officialApplyUrl,
        page.url(),
        responseStatus,
      );
    }
    if (!page.url() || page.url() === "about:blank") throw new ApplicationNavigationError("Lever Apply navigation finished on about:blank.", officialApplyUrl, page.url(), responseStatus);
    await onPageLoaded?.(`Lever application form page loaded at ${page.url()}.`);
  }

  const fields = await visibleFormFields(page);
  return {
    listingUrl,
    finalUrl: page.url(),
    httpStatus: responseStatus,
    formDetected: fields.length > 0,
    fieldCount: fields.length,
    reusedExistingPage: false,
    fields,
  };
}
