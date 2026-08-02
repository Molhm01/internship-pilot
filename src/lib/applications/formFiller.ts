import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import type { FillContext, FillResult, StopReason } from "./types";
import { lookupAnswer } from "./answerBank";
import { getApprovedAnswer } from "./approvedAnswers";
import { normalizeQuestionText } from "./approvedAnswers";
import { captureApplicationStep } from "./browserAgent";
import { recordRunStage } from "./validation";

function absolute(relativePath: string): string {
  return path.isAbsolute(relativePath) ? relativePath : path.join(/* turbopackIgnore: true */ process.cwd(), relativePath);
}

type ScannedField = {
  index: number;
  tag: "input" | "textarea" | "select";
  type: string; // input type, or "textarea"/"select"
  label: string;
  required: boolean;
  options: string[]; // select only
  ariaLabel: string;
  placeholder: string;
  nearbyText: string;
  pageUrl: string;
  optionLabel: string;
};

const TERMS_PATTERN = /\b(certify|certification|terms (of|&) (service|use)|agree to|acknowledge|consent)\b/i;
const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="challenge"]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
];
const ASSESSMENT_KEYWORDS = /\b(coding assessment|skills assessment|complete (a|the) (test|assessment)|hackerrank|codesignal|criteria corp)\b/i;

async function scanFields(page: Page): Promise<ScannedField[]> {
  // NOTE: this callback is serialized to a string by Playwright and run in
  // an isolated browser context that has no access to the Node module scope
  // — including esbuild/tsx's injected `__name(...)` helper that wraps named
  // `function` declarations for name-preservation. Using `const x = (...) =>`
  // instead of `function x(...) {}` avoids that wrapper (arrow functions
  // assigned to a const get `.name` from the JS spec itself, so esbuild
  // doesn't need to inject anything), which is what keeps this evaluable
  // standalone in the page.
  return page.evaluate(() => {
    const labelFor = (el: Element): string => {
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl?.textContent?.trim()) return lbl.textContent.trim();
      }
      const closestLabel = el.closest("label");
      if (closestLabel?.textContent?.trim()) return closestLabel.textContent.trim();
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel?.trim()) return ariaLabel.trim();
      const ariaLabelledBy = el.getAttribute("aria-labelledby");
      if (ariaLabelledBy) {
        const ref = document.getElementById(ariaLabelledBy);
        if (ref?.textContent?.trim()) return ref.textContent.trim();
      }
      const placeholder = (el as HTMLInputElement).placeholder;
      if (placeholder?.trim()) return placeholder.trim();
      return (el.getAttribute("name") || "").trim();
    };

    const isRequired = (el: Element): boolean => {
      if ((el as HTMLInputElement).required) return true;
      if (el.getAttribute("aria-required") === "true") return true;
      const id = el.getAttribute("id");
      const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
      if (lbl?.textContent?.includes("*")) return true;
      return false;
    };

    const candidates = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select',
      ),
    ).filter((el) => el.getClientRects().length > 0 && !el.closest('[hidden], [aria-hidden="true"]'));

    return candidates.map((el, index) => {
      el.setAttribute("data-app-agent-index", String(index));
      const tag = el.tagName.toLowerCase() as "input" | "textarea" | "select";
      const type = tag === "input" ? (el as HTMLInputElement).type || "text" : tag;
      const optionLabel = el.closest("label")?.textContent?.replace(/\s+/g, " ").trim() || (el as HTMLInputElement).value || "";
      const fieldsetLabel = el.closest("fieldset")?.querySelector("legend")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const question = el.closest(".application-question, [role=group]");
      const questionLabel = question?.querySelector(".application-label, legend, [role=heading]")?.textContent?.replace(/\s+/g, " ").trim() || question?.getAttribute("aria-label") || "";
      const groupLabel = fieldsetLabel || questionLabel;
      const radioName = tag === "input" && (el as HTMLInputElement).type === "radio" ? (el as HTMLInputElement).name : "";
      const options = tag === "select"
        ? Array.from((el as HTMLSelectElement).options).map((o) => o.textContent?.trim() || "")
        : radioName
          ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${CSS.escape(radioName)}"]`)).map((radio) => radio.closest("label")?.textContent?.replace(/\s+/g, " ").trim() || radio.value)
          : [];
      return {
        index,
        tag,
        type,
        label: (tag === "input" && ((el as HTMLInputElement).type === "radio" || (el as HTMLInputElement).type === "checkbox") && groupLabel) ? groupLabel : labelFor(el),
        required: isRequired(el),
        options,
        ariaLabel: el.getAttribute("aria-label")?.trim() || "",
        placeholder: (el as HTMLInputElement).placeholder?.trim() || "",
        nearbyText: el.parentElement?.textContent?.replace(/\s+/g, " ").trim().slice(0, 300) || "",
        pageUrl: window.location.href,
        optionLabel,
      };
    });
  });
}

async function detectStopConditions(page: Page): Promise<StopReason | null> {
  for (const sel of CAPTCHA_SELECTORS) {
    if ((await page.locator(sel).count()) > 0) return "captcha";
  }
  if ((await page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[aria-label*="verification code" i]').count()) > 0) return "mfa";
  if ((await page.locator('input[type="password"]').count()) > 0) return "login_required";

  const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
  if (/\b(multi-factor|two-factor|verification code|authenticator code)\b/i.test(bodyText)) return "mfa";
  if (ASSESSMENT_KEYWORDS.test(bodyText)) return "assessment_required";

  return null;
}

async function describePageStop(page: Page, reason: StopReason): Promise<{ label: string; details: ScannedField }> {
  const fields = await scanFields(page).catch(() => [] as ScannedField[]);
  const matching = fields.find((field) => {
    const text = `${field.label} ${field.ariaLabel} ${field.placeholder}`;
    if (reason === "login_required") return field.type === "password" || /login|password|email/i.test(text);
    if (reason === "mfa") return /verification|one.?time|otp|authenticator|code/i.test(text);
    return false;
  });
  if (matching) return { label: matching.label || matching.ariaLabel || matching.placeholder || "(Label unavailable)", details: matching };

  const pageContext = await page.evaluate(() => {
    const challenge = document.querySelector('iframe[src*="captcha" i], iframe[title*="challenge" i], [class*="captcha" i], [id*="captcha" i]');
    return {
      ariaLabel: challenge?.getAttribute("aria-label")?.trim() || "",
      placeholder: challenge?.getAttribute("placeholder")?.trim() || "",
      nearbyText: (challenge?.parentElement?.textContent || document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
      pageUrl: window.location.href,
      title: challenge?.getAttribute("title")?.trim() || "",
    };
  }).catch(() => ({ ariaLabel: "", placeholder: "", nearbyText: "", pageUrl: page.url(), title: "" }));
  const fallbackLabel = pageContext.title || pageContext.ariaLabel || ({
    captcha: "CAPTCHA challenge",
    mfa: "Multi-factor authentication code",
    login_required: "Account login",
    assessment_required: "Hiring assessment",
  } as Partial<Record<StopReason, string>>)[reason] || "(Label unavailable)";
  return {
    label: fallbackLabel,
    details: {
      index: -1,
      tag: "input",
      type: reason === "captcha" ? "challenge" : reason === "assessment_required" ? "assessment" : "text",
      label: fallbackLabel,
      required: true,
      options: [],
      ariaLabel: pageContext.ariaLabel,
      placeholder: pageContext.placeholder,
      nearbyText: pageContext.nearbyText,
      pageUrl: pageContext.pageUrl,
      optionLabel: "",
    },
  };
}

async function findSubmitButton(page: Page) {
  const candidates = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")',
  );
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) if (await candidates.nth(index).isVisible()) return candidates.nth(index);
  return null;
}

// Multi-step ATS wizards (Workday, iCIMS, SuccessFactors commonly split the
// application across several pages) use a "Next"/"Continue" button distinct
// from the final Submit button. Checked only after confirming no Submit
// button is present on the current page, so a page with both a submit-like
// label AND a next-like label (rare) still prefers treating it as final.
async function findNextButton(page: Page) {
  const candidates = page.locator(
    'button:has-text("Next"), button:has-text("Continue"), button:has-text("Save & Continue"), input[value="Next"], input[value="Continue"]',
  );
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) if (await candidates.nth(index).isVisible()) return candidates.nth(index);
  return null;
}

const MAX_STEPS = 8;

function extractConfirmationNumber(text: string): string | undefined {
  const m = text.match(/confirmation\s*(?:number|#|id)?\s*[:#]?\s*([A-Za-z0-9-]{4,})/i);
  return m ? m[1] : undefined;
}

// Fills every recognizable field on the CURRENT page/step only. Returns a
// FillResult if something requires stopping (added to `answers`/screenshot
// paths as it goes), or null if the step completed cleanly and the caller
// should decide whether to advance to a next step or treat this as final.
async function fillFieldsOnCurrentPage(
  page: Page,
  ctx: FillContext,
  runDir: string,
  answers: Record<string, string>,
  blankFieldIndices: number[],
  stepNumber: number,
): Promise<FillResult | null> {
  const fields = await scanFields(page);

  for (const field of fields) {
    const locator = page.locator(`[data-app-agent-index="${field.index}"]`);

    if (field.type === "file") {
      const isCoverLetter = /cover\s*letter/i.test(field.label);
      const filePath = isCoverLetter ? ctx.coverLetterFilePath : ctx.resumeFilePath;
      if (!filePath) {
        if (field.required && !isCoverLetter) {
          const screenshotPath = `${runDir}/stopped-upload_failed.png`;
          await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
          return { status: "needs_user_action", stopReason: "upload_failed", answers, screenshotPath };
        }
        continue; // optional cover letter upload with none generated — leave blank
      }
      try {
        await locator.setInputFiles(absolute(filePath));
        answers[field.label] = path.basename(filePath);
      } catch {
        const screenshotPath = `${runDir}/stopped-upload_failed.png`;
        await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
        return { status: "needs_user_action", stopReason: "upload_failed", answers, screenshotPath };
      }
      continue;
    }

    if (field.type === "checkbox" && TERMS_PATTERN.test(field.label)) {
      const label = field.label || field.ariaLabel || field.placeholder || field.nearbyText || "(Label unavailable)";
      const approved = ctx.approvedRunAnswers?.[normalizeQuestionText(label)] ?? await getApprovedAnswer(label);
      if (approved && /^(yes|true|agree|agreed|confirm|confirmed|accept|accepted)$/i.test(approved.trim())) {
        await locator.check().catch(() => {});
        answers[label] = approved;
        continue;
      }
      const screenshotPath = `${runDir}/stopped-terms_confirmation_required.png`;
      await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
      return {
        status: "needs_user_action",
        stopReason: "terms_confirmation_required",
        stoppedFieldLabel: label,
        stoppedField: { label, type: field.type, required: field.required, options: field.options, step: stepNumber, ariaLabel: field.ariaLabel, placeholder: field.placeholder, nearbyText: field.nearbyText, pageUrl: field.pageUrl },
        answers,
        screenshotPath,
      };
    }

    const displayLabel = field.label || field.ariaLabel || field.placeholder || field.nearbyText || "(Label unavailable)";
    const { category, value: lookedUpValue } = lookupAnswer(ctx, displayLabel);
    let value = ctx.approvedRunAnswers?.[normalizeQuestionText(displayLabel)] ?? lookedUpValue;

    // Reuse a previously-approved answer for generic/unclassified repeated
    // questions only (e.g. "Why do you want to work here?") — never for
    // work-authorization/sponsorship/clearance/EEO, which always require an
    // explicit profile setting rather than an incidentally-saved answer.
    if (value === null) {
      value = await getApprovedAnswer(displayLabel);
    }

    if (value === null) {
      if (!field.required) {
        blankFieldIndices.push(field.index); // optional and unknown — leave blank, no risk, but flag for review
        continue;
      }

      let stopReason: StopReason = "unknown_question";
      if (category === "eeo") stopReason = "eeo_no_saved_preference";
      else if (category === "work_authorization") stopReason = "citizenship_clearance_sponsorship_ambiguous";
      else if (field.tag === "textarea") stopReason = "essay_without_approved_answer";
      else if (category === "unknown") stopReason = "unknown_question";
      else stopReason = "requested_info_not_stored";

      const screenshotPath = `${runDir}/stopped-${stopReason}.png`;
      await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
      return {
        status: "needs_user_action", stopReason, stoppedFieldLabel: displayLabel, answers, screenshotPath,
        stoppedField: { label: displayLabel, type: field.type, required: field.required, options: field.options.filter(Boolean), step: stepNumber, ariaLabel: field.ariaLabel, placeholder: field.placeholder, nearbyText: field.nearbyText, pageUrl: field.pageUrl },
      };
    }

    if (field.tag === "select") {
      const matchOption = field.options.find((o) => o.toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(o.toLowerCase()));
      if (!matchOption) {
        const screenshotPath = `${runDir}/stopped-conflicting_data.png`;
        await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
        return { status: "needs_user_action", stopReason: "conflicting_data", answers, screenshotPath };
      }
      await locator.selectOption({ label: matchOption }).catch(() => {});
      answers[field.label] = matchOption;
    } else if (field.type === "radio") {
      const option = field.optionLabel || "";
      const matches = option.toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(option.toLowerCase());
      if (matches) {
        await locator.check().catch(() => {});
        answers[displayLabel] = option || value;
      }
    } else if (field.type === "checkbox") {
      // Yes/No style work-authorization radios/checkboxes matched by value.
      const wantsChecked = /^(yes|true)$/i.test(value);
      if (wantsChecked) await locator.check().catch(() => {});
      answers[field.label] = value;
    } else {
      await locator.fill(value).catch(() => {});
      answers[field.label] = value;
    }
  }

  return null;
}

export async function fillGenericForm(
  page: Page,
  ctx: FillContext,
  runDir: string,
  // Called immediately before clicking Submit (auto_submit mode only) —
  // the second, independent reverify-before-submission required by the
  // source-security spec, on top of the reverify already done before the
  // application was even opened. Returning ok:false stops the run without
  // ever clicking Submit.
  beforeSubmit?: () => Promise<{ ok: boolean; reason?: string }>,
): Promise<FillResult> {
  await mkdir(absolute(runDir), { recursive: true });
  const answers: Record<string, string> = {};
  const blankFieldIndices: number[] = [];
  await recordRunStage(ctx.runId, "FILLING", "Reading visible controls and filling only grounded answers.");

  const stop = await detectStopConditions(page);
  if (stop) {
    const screenshotPath = `${runDir}/stopped-${stop}.png`;
    await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
    const stopped = await describePageStop(page, stop);
    return { status: "needs_user_action", stopReason: stop, stoppedFieldLabel: stopped.label, stoppedField: { ...stopped.details, step: 1 }, answers, screenshotPath };
  }

  // Multi-step wizard support (Workday/iCIMS/SuccessFactors-style
  // application flows): fill the current step, then advance via a "Next"/
  // "Continue" button and repeat, until a real Submit button is found or no
  // further Next button exists. Every step is subject to the same stop
  // conditions and CAPTCHA/login checks as the first.
  for (let step = 0; step < MAX_STEPS; step++) {
    const domFields = await scanFields(page);
    const domUnderstood = domFields.length > 0;
    const observed = await captureApplicationStep(
      page,
      ctx,
      runDir,
      domUnderstood ? "FILLING" : "dom-unreadable-vision-fallback",
      step + 1,
      { useModel: !domUnderstood },
    );
    if (!domUnderstood) {
      const pause = observed.actions.find((action) => action.action === "pause_for_user");
      const nearbyText = observed.visionError?.message
        ?? observed.modelValidationError?.readable
        ?? (pause?.action === "pause_for_user" ? pause.reason : "No visible form controls were available through the DOM or accessibility tree.");
      return {
        status: "needs_user_action",
        stopReason: pause?.action === "pause_for_user" ? "unknown_question" : "form_not_found",
        stoppedFieldLabel: pause?.action === "pause_for_user" ? pause.question : "Application page could not be understood",
        stoppedField: {
          label: pause?.action === "pause_for_user" ? pause.question : "Application page could not be understood",
          type: "page_intervention",
          required: true,
          options: [],
          step: step + 1,
          ariaLabel: "",
          placeholder: "",
          nearbyText,
          pageUrl: page.url(),
        },
        answers,
        screenshotPath: observed.screenshotPath,
        error: observed.visionError?.message
          ?? (observed.modelValidationError
            ? `${observed.modelValidationError.readable}\nReceived model output: ${observed.modelValidationError.receivedOutput}`
            : undefined),
      };
    }
    if (step > 0) {
      const stepStop = await detectStopConditions(page);
      if (stepStop) {
        const screenshotPath = `${runDir}/stopped-${stepStop}.png`;
        await page.screenshot({ path: absolute(screenshotPath), fullPage: true }).catch(() => {});
        const stopped = await describePageStop(page, stepStop);
        return { status: "needs_user_action", stopReason: stepStop, stoppedFieldLabel: stopped.label, stoppedField: { ...stopped.details, step: step + 1 }, answers, screenshotPath };
      }
    }

    const stepResult = await fillFieldsOnCurrentPage(page, ctx, runDir, answers, blankFieldIndices, step + 1);
    if (stepResult) {
      await captureApplicationStep(page, ctx, runDir, "paused-or-validation-error", step + 1, { useModel: false });
      return stepResult;
    }
    await captureApplicationStep(page, ctx, runDir, "step-completed", step + 1, { useModel: false });

    const hasSubmit = await findSubmitButton(page);
    if (hasSubmit) break; // final step reached

    const nextButton = await findNextButton(page);
    if (!nextButton) break; // nothing more to click — treat current state as final, same as a single-step form

    await nextButton.click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await captureApplicationStep(page, ctx, runDir, "after-continue", step + 1, { useModel: false });
  }

  if (ctx.mode === "fill_to_submit" && blankFieldIndices.length > 0) {
    // Visually mark every optional field left blank so the user reviewing
    // the kept-open browser window can see exactly what still needs their
    // attention before pressing Submit themselves.
    await page
      .evaluate((indices: number[]) => {
        for (const i of indices) {
          const el = document.querySelector(`[data-app-agent-index="${i}"]`) as HTMLElement | null;
          if (el) {
            el.style.outline = "3px solid #f59e0b";
            el.style.outlineOffset = "2px";
          }
        }
      }, blankFieldIndices)
      .catch(() => {});
  }

  const preSubmitScreenshot = `${runDir}/filled.png`;
  await page.screenshot({ path: absolute(preSubmitScreenshot), fullPage: true }).catch(() => {});
  await captureApplicationStep(page, ctx, runDir, "final-review", MAX_STEPS + 1, { useModel: false });

  if (ctx.mode === "fill_to_submit") {
    return { status: "filled", answers, screenshotPath: preSubmitScreenshot };
  }

  if (beforeSubmit) {
    const check = await beforeSubmit();
    if (!check.ok) {
      return {
        status: "needs_user_action",
        stopReason: "posting_closed_before_submit",
        answers,
        screenshotPath: preSubmitScreenshot,
        error: check.reason,
      };
    }
  }

  // auto_submit: click submit, wait for a confirmation signal.
  const submitButton = await findSubmitButton(page);
  if (!submitButton) {
    return { status: "needs_user_action", stopReason: "form_not_found", answers, screenshotPath: preSubmitScreenshot };
  }

  await submitButton.click().catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  const finalText = (await page.locator("body").innerText().catch(() => "")) || "";
  const confirmationNumber = extractConfirmationNumber(finalText);
  const confirmedScreenshot = `${runDir}/submitted.png`;
  await page.screenshot({ path: absolute(confirmedScreenshot), fullPage: true }).catch(() => {});

  const looksSubmitted = /thank you|application (has been |was )?(received|submitted)|we('| ha)ve received your application/i.test(
    finalText,
  );
  if (!looksSubmitted) {
    return {
      status: "needs_user_action",
      stopReason: "form_not_found",
      answers,
      screenshotPath: confirmedScreenshot,
      error: "No confirmation message was detected after clicking submit.",
    };
  }

  return {
    status: "submitted",
    answers,
    screenshotPath: confirmedScreenshot,
    confirmationNumber,
    confirmationUrl: page.url(),
  };
}
