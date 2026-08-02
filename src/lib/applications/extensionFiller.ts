import path from "node:path";
import type { Locator, Page } from "playwright";
import type {
  FillContext,
  FillResult,
  StopReason,
  StoppedFieldDetails,
} from "./types";

const AUTOFILL_SELECTOR = '[data-internship-pilot-action="autofill"]';
const COMPLETION_STATES = [
  "filled",
  "needs_user",
  "blocked",
  "no_form",
  "backend_unreachable",
  "error",
] as const;

type ExtensionDetail = {
  message?: string;
  filled?: number;
  uploaded?: number;
  runId?: string;
  pageUrl?: string;
  blockers?: Array<{ kind: string; detail: string }>;
  needsUser?: Array<{
    label: string;
    reason: string;
    required: boolean;
    type: string;
    options: string[];
    ariaLabel: string;
    placeholder: string;
    nearbyText: string;
  }>;
};

function absolute(relativePath: string): string {
  return path.isAbsolute(relativePath) ? relativePath : path.join(process.cwd(), relativePath);
}

function parseDetail(raw: string | null): ExtensionDetail {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ExtensionDetail;
  } catch {
    return { message: raw };
  }
}

function classifyStop(detail: ExtensionDetail): StopReason {
  const blocker = detail.blockers?.[0];
  if (blocker?.kind === "captcha") return "captcha";
  if (blocker?.kind === "mfa") return "mfa";
  if (blocker?.kind === "login") return "login_required";
  if (blocker?.kind === "assessment") return "assessment_required";
  if (blocker?.kind === "signature" || blocker?.kind === "legal") return "terms_confirmation_required";
  const first = detail.needsUser?.[0];
  const combined = `${first?.label ?? ""} ${first?.reason ?? ""}`;
  if (/citizen|sponsor|visa|clearance|work.?authoriz/i.test(combined)) {
    return "citizenship_clearance_sponsorship_ambiguous";
  }
  if (/gender|race|ethnicity|veteran|disabilit|demographic|eeo/i.test(combined)) {
    return "eeo_no_saved_preference";
  }
  if (/certif|attest|signature|terms|consent|acknowledge|legal/i.test(combined)) {
    return "terms_confirmation_required";
  }
  if (/upload|document/i.test(combined)) return "upload_failed";
  return "unknown_question";
}

function stoppedField(detail: ExtensionDetail, step: number, pageUrl: string): StoppedFieldDetails {
  const first = detail.needsUser?.[0];
  const blocker = detail.blockers?.[0];
  return {
    label: first?.label || blocker?.detail || "(Label unavailable)",
    type: first?.type || (blocker ? "page_intervention" : "unknown"),
    required: first?.required ?? true,
    options: first?.options ?? [],
    step,
    ariaLabel: first?.ariaLabel ?? "",
    placeholder: first?.placeholder ?? "",
    nearbyText: first?.nearbyText || blocker?.detail || detail.message || "",
    pageUrl,
  };
}

async function visibleFinalButton(page: Page): Promise<Locator | null> {
  const controls = page.locator("button, input[type='submit'], [role='button']");
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const text = [
      await control.innerText().catch(() => ""),
      await control.getAttribute("value") ?? "",
      await control.getAttribute("aria-label") ?? "",
    ].join(" ").replace(/\s+/g, " ").trim();
    if (/\b(submit|send application|apply now|finish|complete application)\b/i.test(text)) return control;
  }
  return null;
}

async function visibleNextButton(page: Page): Promise<Locator | null> {
  const controls = page.locator("button, input[type='button'], input[type='submit'], a[role='button']");
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    if (await control.isDisabled().catch(() => true)) continue;
    const text = [
      await control.innerText().catch(() => ""),
      await control.getAttribute("value") ?? "",
      await control.getAttribute("aria-label") ?? "",
    ].join(" ").replace(/\s+/g, " ").trim();
    if (
      /\b(next|continue|save and continue)\b/i.test(text)
      && !/\b(submit|send application|apply now|finish|complete application)\b/i.test(text)
    ) return control;
  }
  return null;
}

async function collectVisibleAnswers(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input:not([type='hidden']):not([type='password']), textarea, select",
    )).filter(visible);
    const answers: Record<string, string> = {};
    for (const control of controls) {
      const explicit = control.id
        ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.textContent
        : "";
      const label = clean(
        explicit
        || control.closest("label")?.textContent
        || control.getAttribute("aria-label")
        || control.getAttribute("placeholder")
        || control.name,
      );
      if (!label) continue;
      if (control instanceof HTMLInputElement && ["radio", "checkbox"].includes(control.type)) {
        if (control.checked) answers[label] = clean(control.value) || "Selected";
      } else if (control instanceof HTMLInputElement && control.type === "file") {
        if (control.files?.[0]) answers[label] = control.files[0].name;
      } else if (control.value) {
        answers[label] = control.value;
      }
    }
    return answers;
  });
}

export async function fillWithInternshipPilotExtension(
  page: Page,
  ctx: FillContext,
  runDirectory: string,
  beforeFinalReview?: () => Promise<{ ok: boolean; reason?: string }>,
): Promise<FillResult> {
  const answers: Record<string, string> = {};

  for (let step = 1; step <= 10; step += 1) {
    await page.evaluate((runId) => {
      document.documentElement.setAttribute("data-internship-pilot-run-id", runId);
    }, ctx.runId);

    const button = page.locator(AUTOFILL_SELECTOR).first();
    try {
      await button.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      const screenshotPath = `${runDirectory}/extension-not-detected-${step}.png`;
      await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
      return {
        status: "failed",
        answers,
        screenshotPath,
        error: "The Internship Pilot Chrome extension did not inject its in-page autofill button.",
      };
    }

    await button.click();
    try {
      await page.waitForFunction(
        ({ selector, states }) => {
          const state = document.querySelector(selector)?.getAttribute("data-ip-state") ?? "";
          return states.some((candidate) => candidate === state);
        },
        { selector: AUTOFILL_SELECTOR, states: [...COMPLETION_STATES] },
        { timeout: 45_000 },
      );
    } catch {
      const screenshotPath = `${runDirectory}/extension-timeout-${step}.png`;
      await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
      return {
        status: "failed",
        answers,
        screenshotPath,
        error: "The extension did not finish its DOM autofill pass within 45 seconds.",
      };
    }

    const state = await button.getAttribute("data-ip-state");
    const detail = parseDetail(await button.getAttribute("data-ip-detail"));
    Object.assign(answers, await collectVisibleAnswers(page));
    const screenshotPath = `${runDirectory}/extension-step-${step}-${state ?? "unknown"}.png`;
    await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});

    if (state === "needs_user" || state === "blocked") {
      const field = stoppedField(detail, step, page.url());
      return {
        status: "needs_user_action",
        stopReason: classifyStop(detail),
        stoppedFieldLabel: field.label,
        stoppedField: field,
        answers,
        screenshotPath,
      };
    }
    if (state !== "filled") {
      return {
        status: state === "no_form" ? "needs_user_action" : "failed",
        stopReason: state === "no_form" ? "form_not_found" : undefined,
        stoppedField: state === "no_form" ? stoppedField(detail, step, page.url()) : undefined,
        answers,
        screenshotPath,
        error: detail.message || `The extension stopped in state ${state ?? "unknown"}.`,
      };
    }

    const finalButton = await visibleFinalButton(page);
    if (finalButton) {
      if (beforeFinalReview) {
        const check = await beforeFinalReview();
        if (!check.ok) {
          return {
            status: "needs_user_action",
            stopReason: "posting_closed_before_submit",
            answers,
            screenshotPath,
            error: check.reason,
          };
        }
      }
      return { status: "filled", answers, screenshotPath };
    }

    const next = await visibleNextButton(page);
    if (!next) {
      if (beforeFinalReview) {
        const check = await beforeFinalReview();
        if (!check.ok) {
          return {
            status: "needs_user_action",
            stopReason: "posting_closed_before_submit",
            answers,
            screenshotPath,
            error: check.reason,
          };
        }
      }
      return { status: "filled", answers, screenshotPath };
    }

    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {}),
      next.click({ timeout: 15_000 }),
    ]);
    await page.waitForTimeout(350);
  }

  return {
    status: "needs_user_action",
    stopReason: "form_not_found",
    stoppedFieldLabel: "Application has more than ten form steps",
    stoppedField: {
      label: "Application has more than ten form steps",
      type: "page_intervention",
      required: true,
      options: [],
      step: 10,
      ariaLabel: "",
      placeholder: "",
      nearbyText: "The extension stopped after ten pages so it could not loop indefinitely.",
      pageUrl: page.url(),
    },
    answers,
  };
}
