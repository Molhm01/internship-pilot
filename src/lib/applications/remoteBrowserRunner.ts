import path from "node:path";
import type { Locator, Page } from "playwright";
import { lookupAnswer, classifyField } from "@/lib/applications/answerBank";
import { normalizeQuestionText } from "@/lib/applications/approvedAnswers";
import {
  generatePortalCredentials,
  pickAutonomousOption,
  resolveAutonomousFieldAnswer,
} from "@/lib/applications/autonomousSolver";
import { headlessChromiumLaunchArgs, resolveChromiumExecutablePath } from "@/lib/applications/chromiumExecutable";
import { isAggregatorUrl, isValidOfficialApplicationUrl } from "@/lib/applications/officialDestination";
import { waitForRecentVerificationCode, waitForRecentVerificationLink } from "@/lib/gmail/verificationCode";
import { writeStoredObject } from "@/lib/storage";
import type { AtsType, FillContext, StopReason, StoppedFieldDetails } from "@/lib/applications/types";

export interface BrowserRunStage {
  stage: string;
  detail: string;
}

export interface BrowserRunFiles {
  resumeBytes: Uint8Array;
  resumeFilename: string;
  coverLetterBytes?: Uint8Array | null;
  coverLetterFilename?: string | null;
}

export interface BrowserRunOutcome {
  status: "submitted" | "filled" | "needs_user_action" | "failed";
  atsType: AtsType;
  answers: Record<string, string>;
  fieldsInspected: number;
  fieldsResolved: number;
  stopReason?: StopReason;
  stoppedFieldLabel?: string;
  stoppedField?: StoppedFieldDetails;
  confirmationNumber?: string;
  confirmationUrl?: string;
  screenshotPath?: string;
  detail: string;
  stages: BrowserRunStage[];
  error?: string;
}

export interface ScannedDomField {
  index: number;
  tag: "input" | "textarea" | "select" | "button";
  type: string;
  name: string;
  label: string;
  required: boolean;
  options: string[];
  ariaLabel: string;
  placeholder: string;
  nearbyText: string;
  pageUrl: string;
  optionLabel: string;
  isCombobox?: boolean;
  currentValue?: string;
  isInvalid?: boolean;
}

const TERMS_PATTERN = /\b(certify|certification|terms (of|&) (service|use)|agree to|acknowledge|consent)\b/i;
const ASSESSMENT_KEYWORDS = /\b(coding assessment|skills assessment|complete (a|the) (test|assessment)|hackerrank|codesignal|criteria corp)\b/i;
const MAX_WIZARD_STEPS = 12;

const CAPTCHA_SELECTORS = [
  'iframe[src*="bframe"]',
  'iframe[title*="challenge" i]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  'div.h-captcha',
  'div.cf-turnstile',
  '[id*="captcha-widget" i]',
  '[class*="captcha-container" i]',
  '[class*="captcha" i]:not(.grecaptcha-badge)',
  '[id*="captcha" i]',
];

export function extractConfirmationNumberFromText(text: string): string | undefined {
  const match = text.match(
    /(?:confirmation|reference|application)\s*(?:number|#|id|code)\s*[:#-]*\s*([A-Z0-9][A-Z0-9-]{3,31})|(?:confirmation|reference|application)\s*[:#]\s*([A-Z0-9][A-Z0-9-]{3,31})/i,
  );
  return match?.[1] || match?.[2];
}

export function looksLikeSubmissionConfirmation(text: string, initialUrl: string, finalUrl: string): boolean {
  if (/\/search(?:\/|\?|$)|[?&](?:q|keywords|locationsearch)=/i.test(finalUrl)) {
    return false;
  }
  if (
    /thank you\s+for\s+(?:applying|submitting|your\s+(?:application|interest))|thanks\s+for\s+applying|application\s+(?:has been\s+|was\s+)?(?:received|submitted|complete)|we(?:'|\s+ha)?ve\s+received\s+your\s+application|we\s+received\s+your\s+application|your\s+application\s+(?:is\s+)?(?:in|submitted|received)|successfully\s+submitted\s+(?:your\s+)?application|confirmation\s*(?:number|#|id)?\s*:/i.test(
      text,
    )
  ) {
    return true;
  }
  if (initialUrl !== finalUrl && /confirm|thank|submitted|success/i.test(finalUrl)) {
    return true;
  }
  return false;
}

export function stopReasonForCategory(category: string, tag: string): StopReason {
  if (category === "eeo") return "eeo_no_saved_preference";
  if (category === "work_authorization") return "citizenship_clearance_sponsorship_ambiguous";
  if (tag === "textarea") return "essay_without_approved_answer";
  if (category === "unknown") return "unknown_question";
  return "requested_info_not_stored";
}

export function resolveGroundedFieldAnswer(
  ctx: FillContext,
  savedAnswers: Record<string, string>,
  label: string,
  field: Pick<ScannedDomField, "type" | "tag">,
): { value: string | null; stopReason?: StopReason; category: string } {
  const normLabel = normalizeQuestionText(label);
  const category = classifyField(label);

  if (field.type === "checkbox" && TERMS_PATTERN.test(label)) {
    const approved = ctx.approvedRunAnswers?.[normLabel] ?? savedAnswers[normLabel] ?? null;
    if (approved && /^(yes|true|agree|agreed|confirm|confirmed|accept|accepted)$/i.test(approved.trim())) {
      return { value: approved.trim(), category };
    }
    return { value: null, stopReason: "terms_confirmation_required", category };
  }

  const lookup = lookupAnswer(ctx, label);
  let value: string | null = ctx.approvedRunAnswers?.[normLabel] ?? lookup.value ?? savedAnswers[normLabel] ?? null;

  if (value !== null && String(value).trim() !== "") {
    return { value: String(value).trim(), category };
  }

  if (category === "how_heard") {
    return { value: "Company Career Site", category };
  }

  value = null;
  return {
    value,
    stopReason: stopReasonForCategory(category, field.tag),
    category,
  };
}

async function scanVisibleDomFields(page: Page): Promise<ScannedDomField[]> {
  return page.evaluate(() => {
    const queryAllDeep = (root: Document | ShadowRoot, selector: string): HTMLElement[] => {
      const out: HTMLElement[] = [];
      try {
        out.push(...Array.from(root.querySelectorAll<HTMLElement>(selector)));
      } catch {
        // Ignore invalid selector in older shadow roots
      }
      const all = root.querySelectorAll<HTMLElement>("*");
      for (const node of all) {
        if (node.shadowRoot) {
          out.push(...queryAllDeep(node.shadowRoot, selector));
        }
      }
      return out;
    };

    const getRoot = (el: Element): Document | ShadowRoot => {
      const r = el.getRootNode();
      return r instanceof ShadowRoot ? r : document;
    };

    const labelFor = (el: Element): string => {
      const root = getRoot(el);
      const id = el.getAttribute("id");
      if (id) {
        const lbl = root.querySelector(`label[for="${CSS.escape(id)}"]`) || document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl?.textContent?.trim()) return lbl.textContent.replace(/\s+/g, " ").trim();
      }
      const closestLabel = el.closest("label");
      if (closestLabel?.textContent?.trim()) {
        const clone = closestLabel.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("input, select, textarea, button").forEach((n) => n.remove());
        const txt = clone.textContent?.replace(/\s+/g, " ").trim();
        if (txt) return txt;
      }
      const ariaLabelledBy = el.getAttribute("aria-labelledby");
      if (ariaLabelledBy) {
        const parts = ariaLabelledBy
          .split(/\s+/)
          .map((refId) => (root instanceof ShadowRoot ? root.getElementById(refId) : document.getElementById(refId))?.textContent?.trim())
          .filter(Boolean);
        if (parts.length > 0) return parts.join(" ").replace(/\s+/g, " ").trim();
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel?.trim() && !/^(search|select\.\.\.|textbox|choose|attach)$/i.test(ariaLabel.trim())) {
        return ariaLabel.trim();
      }
      const fieldWrapper = el.closest(
        '[data-automation-id^="formField-"], .application-question, .jv-form-field, .form-group, .field, [class*="fieldEntry" i], [class*="Field" i], [role="group"], fieldset',
      );
      if (fieldWrapper) {
        const wLabel = fieldWrapper.querySelector('label, legend, [role="heading"], [class*="label" i], [data-automation-id*="label" i]');
        if (wLabel && !wLabel.contains(el) && wLabel.textContent?.trim()) {
          const txt = wLabel.textContent.replace(/\s+/g, " ").trim();
          if (txt && txt.length <= 180) return txt;
        }
      }
      const placeholder = (el as HTMLInputElement).placeholder;
      if (placeholder?.trim() && !/^(search|select\.\.\.|type here|mm|dd|yyyy)$/i.test(placeholder.trim())) {
        return placeholder.trim();
      }
      // Walk up styled-component / Rippling wrappers (which use plain <div>/<p> instead of <label> or .field classes)
      let ancestor: Element | null = el.parentElement;
      for (let depth = 0; depth < 5 && ancestor; depth += 1) {
        if (ancestor.tagName === "FORM" || ancestor.tagName === "MAIN" || ancestor.tagName === "BODY") break;
        const firstBlock = ancestor.firstElementChild;
        if (firstBlock && !firstBlock.contains(el)) {
          const txt = (firstBlock.textContent || "").replace(/\s+/g, " ").trim();
          if (
            txt.length >= 2
            && txt.length <= 180
            && !/^(drop or select|total \d+ file|clear selection|add comment|select\.\.\.|search)$/i.test(txt)
          ) {
            return txt;
          }
        }
        ancestor = ancestor.parentElement;
      }
      if (placeholder?.trim()) return placeholder.trim();
      return (el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("id") || "").trim();
    };

    const isRequired = (el: Element, cleanLabel: string): boolean => {
      if ((el as HTMLInputElement).required) return true;
      if (el.getAttribute("aria-required") === "true") return true;
      const root = getRoot(el);
      const id = el.getAttribute("id");
      const lbl = id ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
      if (lbl?.textContent?.includes("*") || /\*\s*$/.test(cleanLabel)) return true;
      const wrap = el.closest('[data-automation-id^="formField-"], .field, [class*="fieldEntry" i]');
      if (wrap?.querySelector('[aria-label*="required" i], .required, abbr[title*="required" i]')) return true;
      return false;
    };

    // Clear stale field indices from previous scans / hidden steps so Playwright strict locators never collide
    for (const stale of queryAllDeep(document, "[data-pilot-field-index]")) {
      stale.removeAttribute("data-pilot-field-index");
    }

    const rawControls = queryAllDeep(
      document,
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select, button[aria-haspopup="listbox"]',
    );

    const candidates = rawControls.filter((el) => {
      if (el.closest('header, nav, footer, [role="search"], form[action*="search" i]')) return false;
      if (el.closest('[hidden], [aria-hidden="true"]')) return false;
      if (el.classList.contains("iti__selected-country") || el.classList.contains("iti__search-input")) return false;
      if (el.closest(".g-recaptcha, .grecaptcha-badge")) return false;
      const nameOrId = `${el.getAttribute("name") || ""} ${el.id || ""}`;
      if (/g-recaptcha-response|h-captcha-response|cf-turnstile-response/i.test(nameOrId)) return false;
      const automationId = (el.getAttribute("data-automation-id") || "").toLowerCase();
      if (automationId === "beecatcher" || /honeypot/i.test(nameOrId)) {
        return false;
      }
      const tag = el.tagName.toLowerCase();
      const inputType = tag === "input" ? ((el as HTMLInputElement).type || "text").toLowerCase() : tag;
      if (inputType === "file") {
        const container =
          el.closest('form, .file-upload, .file-upload-group, .jv-form-field, .form-group, [role="group"], [class*="field" i], main') || el.parentElement;
        if (!container) return true;
        const st = window.getComputedStyle(container);
        return st.display !== "none" && st.visibility !== "hidden" && container.getClientRects().length > 0;
      }
      const isCombobox = el.getAttribute("role") === "combobox" || el.classList.contains("select__input");
      if (inputType === "radio" || inputType === "checkbox") {
        const container =
          el.closest('label, [role="radiogroup"], [role="group"], fieldset, .field, .form-group, [class*="field" i], [class*="radio" i], [class*="checkbox" i]')
          || el.parentElement;
        if (!container) return false;
        const st = window.getComputedStyle(container);
        if (st.display === "none" || st.visibility === "hidden" || container.getClientRects().length === 0) return false;
        const cr = container.getBoundingClientRect();
        if (cr.width < 8 || cr.height < 8) return false;
      } else if (isCombobox) {
        const visualBox =
          el.closest(".select__control")
          || el.parentElement?.closest('[class*="select" i], [class*="combobox" i]')
          || el.parentElement
          || el;
        const vr = visualBox.getBoundingClientRect();
        const st = window.getComputedStyle(visualBox);
        if (st.display === "none" || st.visibility === "hidden" || vr.width < 12 || vr.height < 12) return false;
      } else {
        if (el.getClientRects().length === 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 2 && rect.height <= 2) return false;
      }
      const meta = `${el.id} ${el.getAttribute("name") || ""} ${el.getAttribute("aria-label") || ""} ${(el as HTMLInputElement).placeholder || ""}`;
      if (!el.closest('[role="dialog"]') && /\b(?:search by keyword|search by location|job search|filter jobs|input-select-search)\b/i.test(meta)) {
        return false;
      }
      return true;
    });

    const results: ScannedDomField[] = [];
    let fieldIndex = 0;

    for (const el of candidates) {
      el.setAttribute("data-pilot-field-index", String(fieldIndex));
      const tag = el.tagName.toLowerCase() as "input" | "textarea" | "select" | "button";
      const type =
        tag === "input"
          ? ((el as HTMLInputElement).type || "text").toLowerCase()
          : tag === "button"
            ? "listbox"
            : tag;
      const optionLabel =
        el.closest('[role="radio"]')?.textContent?.replace(/\s+/g, " ").trim()
        || el.closest("label")?.textContent?.replace(/\s+/g, " ").trim()
        || (el.id ? (getRoot(el).querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.replace(/\s+/g, " ").trim() ?? "") : "")
        || (el as HTMLInputElement).value
        || "";
      const fieldsetLabel =
        el.closest("fieldset")?.querySelector("legend")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const question = el.closest(
        '[data-automation-id^="formField-"], [role="radiogroup"], .application-question, .jv-form-field, .form-group, .file-upload, .field, [class*="fieldEntry" i], [role="group"], fieldset',
      );
      const questionLabelEl = question?.querySelector(
        ".application-label, .jv-form-field-label, legend, [role=heading], label:not(:has(input[type=radio])):not(:has(input[type=checkbox]))",
      );
      let questionLabel =
        (questionLabelEl && !questionLabelEl.contains(el) ? questionLabelEl.textContent?.replace(/\s+/g, " ").trim() : "")
        || question?.getAttribute("aria-label")
        || "";
      if (!questionLabel && question?.getAttribute("aria-labelledby")) {
        const refId = question.getAttribute("aria-labelledby")!;
        questionLabel = document.getElementById(refId)?.textContent?.replace(/\s+/g, " ").trim() || "";
      }
      if (!questionLabel && (type === "radio" || type === "checkbox") && question) {
        // Walk up past [role="radiogroup"] to capture Rippling's preceding <p> question text
        const prevSibText = question.previousElementSibling?.textContent?.replace(/\s+/g, " ").trim() || "";
        const parentFirstText = question.parentElement?.firstElementChild && !question.parentElement.firstElementChild.contains(el)
          ? (question.parentElement.firstElementChild.textContent || "").replace(/\s+/g, " ").trim()
          : "";
        const candidateQ = prevSibText || parentFirstText;
        if (candidateQ && candidateQ !== optionLabel && candidateQ.length <= 360) {
          questionLabel = candidateQ;
        }
      }
      const groupLabel = fieldsetLabel || questionLabel;
      const rawLabel = labelFor(el);

      let displayLabel =
        tag === "input" && (type === "radio" || type === "checkbox") && groupLabel
          ? groupLabel
          : rawLabel || questionLabel;

      // Rippling spinbutton date inputs (aria-label="month"/"day"/"year" with placeholder MM/DD/YYYY)
      if (el.getAttribute("role") === "spinbutton") {
        const spinAria = (el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || "").trim();
        if (/^(?:month|day|year|mm|dd|yyyy)$/i.test(spinAria)) {
          displayLabel = spinAria;
        }
      }

      // Detect phone dialing country code controls (Rippling input[role="combobox"] value="+1 US" OR button "+1 US")
      const rawInputVal = tag === "input" ? ((el as HTMLInputElement).value || "").trim() : "";
      if (
        (tag === "button" && type === "listbox" && /^\+\d{1,4}\b/.test((el.textContent || "").trim()))
        || (tag === "input" && el.getAttribute("role") === "combobox" && /^\+\d{1,4}\b/.test(rawInputVal))
        || /country.*code|phone.*code/i.test(`${displayLabel} ${el.getAttribute("aria-label") || ""}`)
      ) {
        displayLabel = "Phone Country Code";
      }

      if (type === "file") {
        const directFileMeta = `${el.id} ${el.getAttribute("name") || ""} ${el.getAttribute("data-testid") || ""} ${rawLabel} ${el.getAttribute("aria-label") || ""}`;
        const tightWrap = el.closest('.file-upload, .file-upload-group, .field, [class*="field" i], fieldset');
        const tightText = tightWrap && tightWrap.tagName !== "FORM" ? tightWrap.textContent?.slice(0, 140) || "" : "";
        if (/cover[\s_-]*letter/i.test(directFileMeta)) {
          displayLabel = "Cover Letter";
        } else if (/\b(resume|cv)\b/i.test(directFileMeta)) {
          displayLabel = "Resume";
        } else if (/cover[\s_-]*letter/i.test(`${questionLabel} ${tightText}`)) {
          displayLabel = "Cover Letter";
        } else if (!displayLabel || /^(attach|upload|browse|choose file|drop or select)/i.test(displayLabel)) {
          displayLabel = "Resume";
        }
      }

      let radioName = tag === "input" && type === "radio" ? (el as HTMLInputElement).name : "";
      if (tag === "input" && type === "radio" && !radioName && question) {
        radioName = `rg-${(questionLabel || displayLabel).slice(0, 40)}`;
      }
      const options =
        tag === "select"
          ? Array.from((el as HTMLSelectElement).options).map((o) => o.textContent?.trim() || "")
          : tag === "input" && type === "radio" && (el as HTMLInputElement).name
            ? Array.from(
                getRoot(el).querySelectorAll<HTMLInputElement>(`input[type=radio][name="${CSS.escape((el as HTMLInputElement).name)}"]`),
              ).map(
                (radio) =>
                  radio.closest('[role="radio"]')?.textContent?.replace(/\s+/g, " ").trim()
                  || radio.closest("label")?.textContent?.replace(/\s+/g, " ").trim()
                  || (radio.id ? getRoot(radio).querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.textContent?.replace(/\s+/g, " ").trim() : "")
                  || radio.value,
              )
            : [];

      const isCombobox = el.getAttribute("role") === "combobox" || el.classList.contains("select__input");
      let currentValue = "";
      if (tag === "button") {
        const btnText = (el.textContent || "").replace(/\s+/g, " ").trim();
        currentValue = /^(select one|choose|select|\s*)$/i.test(btnText) ? "" : btnText;
      } else if (tag === "select") {
        const sel = el as HTMLSelectElement;
        const opt = sel.options[sel.selectedIndex];
        currentValue = opt && sel.value ? opt.textContent?.trim() || sel.value : "";
      } else if (type === "checkbox" || type === "radio") {
        currentValue = (el as HTMLInputElement).checked ? "checked" : "";
      } else if (isCombobox) {
        const control = el.closest(".select__control") || el.parentElement?.closest('[class*="select" i]');
        const singleVal = control?.querySelector('.select__single-value, [class*="singleValue" i]')?.textContent?.trim();
        currentValue = singleVal || (el as HTMLInputElement).value || "";
      } else {
        currentValue = (el as HTMLInputElement | HTMLTextAreaElement).value || "";
      }

      const isInvalid =
        el.getAttribute("aria-invalid") === "true"
        || Boolean(question?.querySelector('[role="alert"], .error, .input__error, [class*="error" i]:not(svg)'));

      results.push({
        index: fieldIndex,
        tag,
        type,
        name: radioName || el.getAttribute("name") || el.getAttribute("id") || "",
        label: displayLabel.replace(/\*+\s*$/, "").trim() || displayLabel,
        required: isRequired(el, rawLabel || questionLabel),
        options,
        ariaLabel: el.getAttribute("aria-label")?.trim() || "",
        placeholder: (el as HTMLInputElement).placeholder?.trim() || "",
        nearbyText: (question?.textContent || el.parentElement?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
        pageUrl: window.location.href,
        optionLabel: optionLabel.replace(/\*+\s*$/, "").trim(),
        isCombobox,
        currentValue,
        isInvalid,
      });
      fieldIndex += 1;
    }

    // Scan custom ARIA [role="radiogroup"] containing [role="radio"] (when no native input[type="radio"] exists inside)
    const ariaRadioGroups = queryAllDeep(document, '[role="radiogroup"]');
    let ariaGroupCounter = 0;
    for (const rg of ariaRadioGroups) {
      if (rg.closest('header, nav, footer, [hidden], [aria-hidden="true"]')) continue;
      if (rg.querySelector('input[type="radio"]')) continue;
      const ariaRadios = Array.from(rg.querySelectorAll<HTMLElement>('[role="radio"]')).filter(
        (r) => r.getClientRects().length > 0,
      );
      if (ariaRadios.length === 0) continue;
      ariaGroupCounter += 1;
      const gName = `aria-rg-${ariaGroupCounter}`;
      const labelledById = rg.getAttribute("aria-labelledby");
      const gLabel =
        rg.getAttribute("aria-label")?.trim()
        || (labelledById ? document.getElementById(labelledById)?.textContent?.replace(/\s+/g, " ").trim() : "")
        || rg.previousElementSibling?.textContent?.replace(/\s+/g, " ").trim()
        || rg.parentElement?.querySelector("label, legend, p, [role=heading]")?.textContent?.replace(/\s+/g, " ").trim()
        || "Option";
      const opts = ariaRadios.map((r) => (r.textContent || r.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim());
      for (const r of ariaRadios) {
        r.setAttribute("data-pilot-field-index", String(fieldIndex));
        const optText = (r.textContent || r.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        results.push({
          index: fieldIndex,
          tag: "button",
          type: "radio",
          name: gName,
          label: gLabel.replace(/\*+\s*$/, "").trim(),
          required: gLabel.includes("*") || rg.getAttribute("aria-required") === "true" || Boolean(rg.parentElement?.textContent?.includes("This field is required")),
          options: opts,
          ariaLabel: r.getAttribute("aria-label")?.trim() || optText,
          placeholder: "",
          nearbyText: (rg.parentElement?.textContent || rg.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
          pageUrl: window.location.href,
          optionLabel: optText,
          currentValue: r.getAttribute("aria-checked") === "true" ? "checked" : "",
          isInvalid: Boolean(rg.parentElement?.querySelector('[role="alert"], [class*="error" i]')),
        });
        fieldIndex += 1;
      }
    }

    // Scan Ashby / custom Yes-No button toggle groups (not native <input type="radio">)
    const yesNoContainers = queryAllDeep(document, '[class*="fieldEntry" i], [class*="yesno" i], [role="group"], fieldset');
    const seenYesNo = new Set<Element>();
    for (const container of yesNoContainers) {
      if (seenYesNo.has(container) || container.closest('header, nav, footer')) continue;
      if (container.querySelector('input[type="radio"], select')) continue;
      const btns = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (b) => b.getClientRects().length > 0 && /^(yes|no)$/i.test((b.textContent || "").trim()),
      );
      if (btns.length === 2) {
        const texts = btns.map((b) => (b.textContent || "").trim().toLowerCase());
        if (texts.includes("yes") && texts.includes("no")) {
          seenYesNo.add(container);
          container.setAttribute("data-pilot-field-index", String(fieldIndex));
          const outerWrap = container.closest('[class*="field" i], .form-group, fieldset') || container.parentElement;
          const qLabel =
            container.querySelector("label, legend, [role=heading], p")?.textContent?.replace(/\s+/g, " ").trim()
            || container.getAttribute("aria-label")
            || outerWrap?.querySelector("label, legend, [role=heading], p")?.textContent?.replace(/\s+/g, " ").trim()
            || "";
          const activeBtn = btns.find(
            (b) => b.getAttribute("aria-pressed") === "true" || /active|selected|checked/i.test(b.className || ""),
          );
          if (qLabel) {
            results.push({
              index: fieldIndex,
              tag: "button",
              type: "yesno",
              name: qLabel.slice(0, 48),
              label: qLabel.replace(/\*+\s*$/, "").trim(),
              required: qLabel.includes("*") || Boolean(container.querySelector('[aria-required="true"], .required')),
              options: ["Yes", "No"],
              ariaLabel: qLabel,
              placeholder: "",
              nearbyText: (container.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
              pageUrl: window.location.href,
              optionLabel: "",
              currentValue: activeBtn ? (activeBtn.textContent || "").trim() : "",
              isInvalid: Boolean(container.querySelector('[role="alert"], [class*="error" i]')),
            });
            fieldIndex += 1;
          }
        }
      }
    }

    return results;
  });
}

async function dismissCookieBanners(page: Page): Promise<void> {
  const cookieSelectors = [
    '[data-automation-id="legalNoticeAcceptButton"]:visible',
    '#onetrust-accept-btn-handler:visible',
    'button:has-text("Accept Cookies"):visible',
    'button:has-text("Accept All Cookies"):visible',
    'button:has-text("Accept All"):visible',
    'button:has-text("AGREE AND PROCEED"):visible',
  ];
  for (const sel of cookieSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2_500 }).catch(() => undefined);
      await page.waitForTimeout(250);
    }
  }
}

async function fillAndSubmitAuthFields(
  page: Page,
  creds: ReturnType<typeof generatePortalCredentials>,
  preferSignIn: boolean,
): Promise<{ clickedLabel: string | null }> {
  const emailInputs = page.locator(
    '[data-automation-id="email"]:visible, input[type="email"]:visible, input[aria-label*="Email" i]:visible, input[name*="email" i]:visible, input[id*="email" i]:visible, input[name*="username" i]:visible',
  );
  const emailCount = await emailInputs.count().catch(() => 0);
  for (let i = 0; i < emailCount; i += 1) {
    const inp = emailInputs.nth(i);
    if (await inp.isVisible().catch(() => false)) {
      await inp.fill(creds.email).catch(() => undefined);
    }
  }

  const firstInputs = page.locator('input[name*="first" i][name*="name" i]:visible, input[id*="first" i][id*="name" i]:visible');
  if ((await firstInputs.count().catch(() => 0)) > 0) {
    await firstInputs.first().fill(creds.firstName).catch(() => undefined);
  }
  const lastInputs = page.locator('input[name*="last" i][name*="name" i]:visible, input[id*="last" i][id*="name" i]:visible');
  if ((await lastInputs.count().catch(() => 0)) > 0) {
    await lastInputs.first().fill(creds.lastName).catch(() => undefined);
  }

  const passwordInputs = page.locator('input[type="password"]:visible');
  const totalPw = await passwordInputs.count().catch(() => 0);
  for (let i = 0; i < totalPw; i += 1) {
    const inp = passwordInputs.nth(i);
    if (await inp.isVisible().catch(() => false)) {
      await inp.fill(creds.password).catch(() => undefined);
    }
  }

  const consentBoxes = page.locator('[data-automation-id="createAccountCheckbox"]:visible, [role="dialog"] input[type="checkbox"]:visible, form input[type="checkbox"]:visible');
  const consentCount = await consentBoxes.count().catch(() => 0);
  for (let i = 0; i < consentCount; i += 1) {
    await consentBoxes.nth(i).check({ force: true }).catch(() => undefined);
  }

  // SAP SuccessFactors (e.g. AMETEK) requires clicking "Read and accept the data privacy statement." link and accepting in modal before Create Account
  const privacyLink = page
    .locator('a:has-text("data privacy statement"):visible, a:has-text("Read and accept"):visible')
    .first();
  if (await privacyLink.isVisible().catch(() => false)) {
    await privacyLink.click({ timeout: 4_000 }).catch(() => undefined);
    await page.waitForTimeout(700);
    const acceptModalBtn = page
      .locator('[role="dialog"] button:has-text("Accept"):visible, .ui-dialog button:has-text("Accept"):visible, button:text-is("Accept"):visible')
      .first();
    if (await acceptModalBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await acceptModalBtn.click({ timeout: 4_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }

  const orderedSelectors = preferSignIn
    ? [
        '[data-automation-id="signInSubmitButton"]:visible',
        'button:has-text("Sign In"):visible',
        'button:has-text("Log In"):visible',
        'button[type="submit"]:visible',
        'input[type="submit"]:visible',
      ]
    : [
        '[data-automation-id="createAccountSubmitButton"]:visible',
        'button:has-text("Create Account"):visible',
        'button:has-text("Sign Up"):visible',
        'button:has-text("Register"):visible',
        '[data-automation-id="signInSubmitButton"]:visible',
        'button[type="submit"]:visible',
        'input[type="submit"]:visible',
        'button:has-text("Sign In"):visible',
        'button:has-text("Log In"):visible',
        'button:has-text("Continue"):visible',
      ];

  for (const sel of orderedSelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.isVisible().catch(() => false)) && !(await btn.isDisabled().catch(() => false))) {
      const text = ((await btn.innerText().catch(() => "")) || sel).trim();
      // Workday wraps createAccountSubmitButton / signInSubmitButton with an intercepting click_filter overlay
      const clicked = await btn.click({ timeout: 4_000 }).then(() => true).catch(() => false);
      if (!clicked) {
        const clickFilter = page.locator('[data-automation-id="click_filter"]:visible').first();
        if (await clickFilter.isVisible().catch(() => false)) {
          await clickFilter.click({ force: true, timeout: 4_000 }).catch(() => undefined);
        } else {
          await btn.click({ force: true, timeout: 4_000 }).catch(() => undefined);
        }
      }
      return { clickedLabel: text };
    }
  }
  return { clickedLabel: null };
}

async function handleMicrosoftSsoFlow(
  page: Page,
  atsType: AtsType,
  ctx: FillContext,
  creds: ReturnType<typeof generatePortalCredentials>,
  answers: Record<string, string>,
  fieldsInspected: number,
  fieldsResolved: number,
  runDir: string,
  stages: BrowserRunStage[],
  options: { userId?: string; gmailAccessToken?: string | null },
): Promise<{ handled: boolean; pauseOutcome?: BrowserRunOutcome }> {
  const ssoBtn = page
    .locator(
      '[role="dialog"] button:has-text("Sign up using Microsoft"):visible, [role="dialog"] button:has-text("Sign in using Microsoft"):visible',
    )
    .first();
  if (!(await ssoBtn.isVisible().catch(() => false))) {
    return { handled: false };
  }

  const ssoStartedAt = Date.now();
  const [popup] = await Promise.all([
    page.context().waitForEvent("page", { timeout: 6_000 }).catch(() => null),
    ssoBtn.click({ timeout: 8_000 }).catch(() => undefined),
  ]);

  const authPage = popup ?? page;
  await authPage.waitForLoadState("domcontentloaded", { timeout: 12_000 }).catch(() => undefined);
  await authPage
    .waitForSelector(
      'input[name="loginfmt"]:visible, input[type="email"]:visible, input[type="password"]:visible, #signup:visible',
      { timeout: 10_000 },
    )
    .catch(() => null);
  await authPage.waitForTimeout(800).catch(() => undefined);

  const authUrl = authPage.url();
  stages.push({
    stage: "PORTAL_SSO_OPENED",
    detail: `Opened Microsoft identity authentication (${authUrl.includes("login.") || authUrl.includes("live.com") ? "Microsoft Account OAuth" : authUrl}).`,
  });

  const emailBox = authPage.locator('input[name="loginfmt"]:visible, input[type="email"]:visible').first();
  if (!authPage.isClosed() && (await emailBox.isVisible().catch(() => false))) {
    await emailBox.fill(creds.email).catch(() => undefined);
    answers["Portal Login Email"] = creds.email;
    const nextBtn = authPage
      .locator('#idSIButton9:visible, button[type="submit"]:visible, input[type="submit"]:visible')
      .first();
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click({ timeout: 8_000 }).catch(() => undefined);
      await authPage.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      await authPage.waitForTimeout(2_000).catch(() => undefined);
    }
  }

  const afterEmailText = (!authPage.isClosed() ? await authPage.locator("body").innerText().catch(() => "") : "") || "";
  const pwInputAfterEmail = authPage.locator('input[name="passwd"]:visible, input[type="password"]:visible').first();
  const signupLink = authPage.locator('#signup:visible, #idA_PWD_SignUp:visible, a:has-text("Create one"):visible').first();

  if (
    !authPage.isClosed()
    && !(await pwInputAfterEmail.isVisible().catch(() => false))
    && (await signupLink.isVisible().catch(() => false))
    && /\b(?:couldn'?t find an account|doesn'?t exist|no account|create one)\b/i.test(afterEmailText)
  ) {
    await signupLink.click({ timeout: 8_000 }).catch(() => undefined);
    await authPage.waitForLoadState("domcontentloaded", { timeout: 12_000 }).catch(() => undefined);
    await authPage.waitForSelector('input[type="email"]:visible, input[name="email"]:visible', { timeout: 10_000 }).catch(() => null);
    await authPage.waitForTimeout(700).catch(() => undefined);

    const signupEmail = authPage.locator('input[type="email"]:visible, input[name="email"]:visible').first();
    if (!authPage.isClosed() && (await signupEmail.isVisible().catch(() => false))) {
      await signupEmail.fill(creds.email).catch(() => undefined);
      const submitSignupEmail = authPage.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
      if (await submitSignupEmail.isVisible().catch(() => false)) {
        await submitSignupEmail.click({ timeout: 8_000 }).catch(() => undefined);
        await authPage.waitForTimeout(2_500).catch(() => undefined);
      }
    }
  } else if (!authPage.isClosed() && (await pwInputAfterEmail.isVisible().catch(() => false))) {
    await pwInputAfterEmail.fill(creds.password).catch(() => undefined);
    const signInBtn = authPage
      .locator('#idSIButton9:visible, button[type="submit"]:visible, input[type="submit"]:visible')
      .first();
    if (await signInBtn.isVisible().catch(() => false)) {
      await signInBtn.click({ timeout: 8_000 }).catch(() => undefined);
      await authPage.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      await authPage.waitForTimeout(2_200).catch(() => undefined);
    }

    const kmsiYes = authPage
      .locator('#acceptButton:visible, input#idSIButton9[value="Yes"]:visible, button:has-text("Yes"):visible')
      .first();
    if (!authPage.isClosed() && (await kmsiYes.isVisible().catch(() => false))) {
      await kmsiYes.click({ timeout: 6_000 }).catch(() => undefined);
      await authPage.waitForTimeout(1_800).catch(() => undefined);
    }
  }

  // Check whether Microsoft signup/login triggered an email verification code step
  const authBody = (!authPage.isClosed() ? await authPage.locator("body").innerText().catch(() => "") : "") || "";
  const hasDigitBoxes =
    !authPage.isClosed()
    && (await authPage.locator('#codeEntry-0:visible, input[name*="code" i]:visible, input[autocomplete="one-time-code"]:visible').count().catch(() => 0)) > 0;
  const looksLikeEmailVerify =
    hasDigitBoxes || /\b(?:verify your email|enter the code we sent|sent a verification code|check your email)\b/i.test(authBody);

  if (!authPage.isClosed() && looksLikeEmailVerify) {
    stages.push({
      stage: "PORTAL_VERIFICATION_EMAIL_SENT",
      detail: `Microsoft sent an email verification code to ${creds.email} to verify your Microsoft Careers account.`,
    });

    const fetchedOtp = options.userId || options.gmailAccessToken
      ? await waitForRecentVerificationCode({
          userId: options.userId,
          accessToken: options.gmailAccessToken,
          company: "Microsoft",
          sinceMs: ssoStartedAt,
          timeoutMs: options.gmailAccessToken ? 22_000 : 12_000,
        }).catch(() => null)
      : null;

    if (fetchedOtp && hasDigitBoxes) {
      const codeChars = fetchedOtp.code.trim().split("");
      const firstBox = authPage.locator('#codeEntry-0:visible').first();
      if (await firstBox.isVisible().catch(() => false)) {
        for (let i = 0; i < codeChars.length; i += 1) {
          await authPage.locator(`#codeEntry-${i}`).fill(codeChars[i]).catch(() => undefined);
        }
      } else {
        await authPage
          .locator('input[name*="code" i]:visible, input[autocomplete="one-time-code"]:visible')
          .first()
          .fill(fetchedOtp.code.trim())
          .catch(() => undefined);
      }
      answers["Microsoft Email Verification"] = "[Auto-verified via Gmail]";
      await authPage.locator('button[type="submit"]:visible, input[type="submit"]:visible').first().click().catch(() => undefined);
      await authPage.waitForTimeout(2_500).catch(() => undefined);

      // If Microsoft signup now asks for password / name after OTP, supply them automatically
      const postOtpPw = authPage.locator('input[type="password"]:visible').first();
      if (!authPage.isClosed() && (await postOtpPw.isVisible().catch(() => false))) {
        await postOtpPw.fill(creds.password).catch(() => undefined);
        await authPage.locator('button[type="submit"]:visible, input[type="submit"]:visible').first().click().catch(() => undefined);
        await authPage.waitForTimeout(2_000).catch(() => undefined);
      }
      const firstNameInput = authPage.locator('input[name*="FirstName" i]:visible, input[placeholder*="First name" i]:visible').first();
      if (!authPage.isClosed() && (await firstNameInput.isVisible().catch(() => false))) {
        await firstNameInput.fill(creds.firstName).catch(() => undefined);
        const lastNameInput = authPage.locator('input[name*="LastName" i]:visible, input[placeholder*="Last name" i]:visible').first();
        if (await lastNameInput.isVisible().catch(() => false)) {
          await lastNameInput.fill(creds.lastName).catch(() => undefined);
        }
        await authPage.locator('button[type="submit"]:visible, input[type="submit"]:visible').first().click().catch(() => undefined);
        await authPage.waitForTimeout(2_500).catch(() => undefined);
      }
    }

    if (!authPage.isClosed()) {
      const stillOnAuth = /login\.(?:live|microsoftonline)\.com|signup\.live\.com/i.test(authPage.url());
      if (stillOnAuth) {
        const verifyShot = await saveRunScreenshot(authPage, runDir, "awaiting-microsoft-verification.png");
        return {
          handled: true,
          pauseOutcome: {
            status: "filled",
            atsType,
            answers,
            fieldsInspected,
            fieldsResolved,
            screenshotPath: verifyShot,
            detail: fetchedOtp
              ? `Entered verification code for ${creds.email}, but Microsoft signup requested another interactive security step (e.g. birthdate/CAPTCHA). Complete sign-in via Apply Link, then click Auto-Submit Now.`
              : `Microsoft sent an email verification code to ${creds.email} — check your inbox (or connect Gmail on the Agent page for automatic OTP entry), complete account setup, then click Auto-Submit Now.`,
            stages,
          },
        };
      }
    }
  }

  // Wait for OAuth popup to redirect back and close into the Eightfold application tab
  if (popup && !popup.isClosed()) {
    await popup.waitForEvent("close", { timeout: 6_000 }).catch(() => null);
    await page.waitForSelector('input:not([type="hidden"]):not([type="search"]), select, textarea', { timeout: 6_000 }).catch(() => null);
    await page.waitForTimeout(1_000);
  }

  const stillBlockedOnDialog =
    (await page.locator('[role="dialog"] button:has-text("Sign in using Microsoft"):visible, [role="dialog"] button:has-text("Sign up using Microsoft"):visible').count().catch(() => 0)) > 0;

  if (stillBlockedOnDialog || (popup && !popup.isClosed())) {
    const activeShotTarget = popup && !popup.isClosed() ? popup : page;
    const ssoShot = await saveRunScreenshot(activeShotTarget, runDir, "microsoft-sso-auth-required.png");
    const authErrBody = (!activeShotTarget.isClosed() ? await activeShotTarget.locator("body").innerText().catch(() => "") : "") || "";
    const wrongPassword = /\b(?:password is incorrect|incorrect password|too many times|locked)\b/i.test(authErrBody);
    const reasonDetail = wrongPassword
      ? `Microsoft account login for ${creds.email} failed (password rejected or locked on login.live.com) — update Portal Password under Credentials or sign in once via the Apply Link.`
      : `Microsoft Careers requires completing interactive Microsoft OAuth sign-in for ${creds.email} (e.g. verification/CAPTCHA/2FA on ${authPage.url()}). Sign in via the Apply Link or check ${creds.email} for verification, then retry.`;
    stages.push({
      stage: "PORTAL_SSO_AUTH_REQUIRED",
      detail: reasonDetail,
    });
    return {
      handled: true,
      pauseOutcome: {
        status: "filled",
        atsType,
        answers,
        fieldsInspected,
        fieldsResolved,
        screenshotPath: ssoShot,
        detail: reasonDetail,
        stages,
      },
    };
  }

  return { handled: true };
}

async function handlePortalAuthentication(
  page: Page,
  atsType: AtsType,
  ctx: FillContext,
  answers: Record<string, string>,
  fieldsInspected: number,
  fieldsResolved: number,
  runDir: string,
  stages: BrowserRunStage[],
  options: { userId?: string; gmailAccessToken?: string | null },
): Promise<{ handled: boolean; pauseOutcome?: BrowserRunOutcome }> {
  const creds = generatePortalCredentials(
    ctx.profile.email,
    ctx.company,
    ctx.profile.fullName,
    ctx.profile.portalPassword,
  );
  let handledAny = false;

  // Pattern A: Microsoft / Eightfold "Sign in" / "First time here? Create an account" modal (no visible password input yet)
  const modalCreateLink = page.locator(
    '[role="dialog"] a:has-text("Create an account"):visible, [role="dialog"] button:has-text("Create an account"):visible, button:has-text("Create an account"):visible, a:has-text("Create an account"):visible',
  ).first();
  if (
    (await modalCreateLink.isVisible().catch(() => false))
    && (await page.locator('input[type="password"]:visible').count().catch(() => 0)) === 0
  ) {
    await modalCreateLink.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_000);
    handledAny = true;

    const countryCombo = page.locator(
      '[role="dialog"] input[role="combobox"]:visible, [role="dialog"] input[placeholder*="country" i]:visible',
    ).first();
    if (await countryCombo.isVisible().catch(() => false)) {
      const targetCountry = ctx.profile.countryOfResidence?.trim() || "United States";
      await countryCombo.click({ timeout: 4_000 }).catch(() => undefined);
      await countryCombo.fill(targetCountry).catch(() => undefined);
      await page.waitForTimeout(600);
      const exactOption = page
        .locator('[role="option"]:visible, [role="listbox"] li:visible')
        .filter({ hasText: new RegExp(`^${targetCountry}$`, "i") })
        .first();
      if (await exactOption.isVisible().catch(() => false)) {
        await exactOption.click({ timeout: 4_000 }).catch(() => undefined);
      } else {
        const firstOpt = page.locator('[role="option"]:visible, [role="listbox"] li:visible').first();
        if (await firstOpt.isVisible().catch(() => false)) {
          await firstOpt.click({ timeout: 4_000 }).catch(() => undefined);
        } else {
          await countryCombo.press("ArrowDown").catch(() => undefined);
          await countryCombo.press("Enter").catch(() => undefined);
        }
      }
      await page.waitForTimeout(550);

      // Select AI-insights visibility radio button revealed after country selection
      const dlgRadios = page.locator('[role="dialog"] input[type="radio"]:visible');
      if ((await dlgRadios.count().catch(() => 0)) > 0) {
        await dlgRadios.first().check({ force: true }).catch(() => dlgRadios.first().click({ force: true }).catch(() => undefined));
      }

      const dlgBoxes = page.locator('[role="dialog"] input[type="checkbox"]:visible');
      const dlgBoxCount = await dlgBoxes.count().catch(() => 0);
      for (let i = 0; i < dlgBoxCount; i += 1) {
        await dlgBoxes.nth(i).check({ force: true }).catch(() => dlgBoxes.nth(i).click({ force: true }).catch(() => undefined));
      }

      const dlgSubmit = page.locator('[role="dialog"] button:has-text("Submit"):visible, [role="dialog"] button:has-text("Continue"):visible').first();
      if ((await dlgSubmit.isVisible().catch(() => false)) && (await dlgSubmit.isEnabled().catch(() => false))) {
        await dlgSubmit.click({ timeout: 8_000 }).catch(() => undefined);
        await page
          .waitForSelector(
            '[role="dialog"] button:has-text("Sign up using Microsoft"):visible, [role="dialog"] button:has-text("Sign in using Microsoft"):visible, input:not([type="hidden"])',
            { timeout: 6_000 },
          )
          .catch(() => null);
        await page.waitForTimeout(800);
        stages.push({
          stage: "PORTAL_ACCOUNT_SIGNUP_STARTED",
          detail: `Started ${ctx.company} account creation flow (${creds.email}, selected ${targetCountry}) and accepted consent settings.`,
        });
      }
    }
  }

  // Pattern A2: Eightfold Microsoft OAuth SSO buttons ("Sign up using Microsoft" / "Sign in using Microsoft")
  if ((await page.locator('input[type="password"]:visible').count().catch(() => 0)) === 0) {
    const ssoOutcome = await handleMicrosoftSsoFlow(
      page,
      atsType,
      ctx,
      creds,
      answers,
      fieldsInspected,
      fieldsResolved,
      runDir,
      stages,
      options,
    );
    if (ssoOutcome.handled) handledAny = true;
    if (ssoOutcome.pauseOutcome) return ssoOutcome;
  }

  // Pattern B: Workday "Sign in with email" pre-step
  const signInWithEmailBtn = page.locator('[data-automation-id="SignInWithEmailButton"]:visible').first();
  if (await signInWithEmailBtn.isVisible().catch(() => false)) {
    await signInWithEmailBtn.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
    handledAny = true;
  }

  const visiblePwCount = await page.locator('input[type="password"]:visible').count().catch(() => 0);
  if (visiblePwCount === 0) return { handled: handledAny };

  // Switch from Login screen to "Create Account" when only 1 password box is shown and confirm-password is not yet open
  if (visiblePwCount === 1) {
    const createAccountTrigger = page.locator(
      '[data-automation-id="createAccountLink"]:visible, button:has-text("Create Account"):visible, a:has-text("Create Account"):visible, a:has-text("Create an Account"):visible, button:has-text("Sign Up"):visible, a:has-text("Sign Up"):visible, button:has-text("Register"):visible',
    ).first();
    if (await createAccountTrigger.isVisible().catch(() => false)) {
      await createAccountTrigger.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(900);
    }
  }

  const { clickedLabel } = await fillAndSubmitAuthFields(page, creds, false);
  if (!clickedLabel) return { handled: handledAny };

  handledAny = true;
  stages.push({
    stage: "PORTAL_ACCOUNT_HANDLED",
    detail: `Submitted candidate portal account credentials (${creds.email}) on ${ctx.company}.`,
  });
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
  await page.waitForTimeout(1_600);

  const afterAuthText = (await page.locator("body").innerText().catch(() => "")) || "";

  // If the account already existed on this ATS, switch to Sign In with the same credentials automatically
  if (/\b(?:account\s+with\s+this\s+email\s+already\s+exists|already\s+(?:exists|registered)|email\s+is\s+already\s+in\s+use)\b/i.test(afterAuthText)) {
    const signInTrigger = page.locator(
      '[data-automation-id="signInLink"]:visible, button:has-text("Sign In"):visible, a:has-text("Sign In"):visible',
    ).first();
    if (await signInTrigger.isVisible().catch(() => false)) {
      await signInTrigger.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(900);
    }
    const retrySignIn = await fillAndSubmitAuthFields(page, creds, true);
    if (retrySignIn.clickedLabel) {
      stages.push({
        stage: "PORTAL_EXISTING_ACCOUNT_SIGNIN",
        detail: `Account already existed — signed in with ${creds.email} on ${ctx.company}.`,
      });
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
      await page.waitForTimeout(1_400);
    }
  }

  const authSubmittedAt = Date.now();
  const postSignInText = (await page.locator("body").innerText().catch(() => "")) || "";
  if (/\b(?:verify your email|verification email|sent an email|check your email|confirm your email|activate your account)\b/i.test(postSignInText)) {
    stages.push({
      stage: "PORTAL_VERIFICATION_EMAIL_SENT",
      detail: `${ctx.company} sent an account verification email to ${creds.email}.`,
    });

    if (options.gmailAccessToken || options.userId) {
      const linkEmail = await waitForRecentVerificationLink({
        userId: options.userId,
        accessToken: options.gmailAccessToken,
        company: ctx.company,
        sinceMs: authSubmittedAt - 45_000,
        timeoutMs: options.gmailAccessToken ? 24_000 : 10_000,
      }).catch(() => null);

      if (linkEmail?.url) {
        const verifyTab = await page.context().newPage().catch(() => null);
        if (verifyTab) {
          try {
            await verifyTab.goto(linkEmail.url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
            await verifyTab.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
            const confirmBtn = verifyTab
              .locator(
                'button:has-text("Verify"):visible, button:has-text("Confirm"):visible, button:has-text("Activate"):visible, a:has-text("Continue"):visible',
              )
              .first();
            if (await confirmBtn.isVisible().catch(() => false)) {
              await confirmBtn.click({ timeout: 5_000 }).catch(() => undefined);
              await verifyTab.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
            }
            await verifyTab.waitForTimeout(1_000);
            answers["Portal Email Verification"] = `[Auto-verified via Gmail link: ${linkEmail.subject.slice(0, 60)}]`;
            stages.push({
              stage: "PORTAL_EMAIL_VERIFIED",
              detail: `Opened verification link from Gmail ("${linkEmail.subject}") and verified ${creds.email} on ${ctx.company}.`,
            });
          } finally {
            await verifyTab.close().catch(() => undefined);
          }

          // Re-attempt sign-in on the original application tab now that the account is verified
          await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
          await page.waitForTimeout(1_000);
          if ((await page.locator('input[type="password"]:visible').count().catch(() => 0)) > 0) {
            await fillAndSubmitAuthFields(page, creds, true);
            await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
            await page.waitForTimeout(1_400);
          }
        }
      }
    }
  }

  return { handled: handledAny };
}

async function hasVisibleCaptchaChallenge(page: Page): Promise<boolean> {
  return page
    .evaluate((selectors) => {
      for (const selector of selectors) {
        const nodes = document.querySelectorAll<HTMLElement>(selector);
        for (const el of nodes) {
          if (el.closest('.grecaptcha-badge, [aria-hidden="true"], [data-size="invisible"]')) continue;
          if (el.getAttribute("data-size") === "invisible") continue;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) {
            continue;
          }
          const rect = el.getBoundingClientRect();
          // Ignore offscreen or zero-sized frames
          if (
            rect.width < 16
            || rect.height < 16
            || rect.right <= 0
            || rect.bottom <= 0
            || rect.left >= window.innerWidth
            || rect.top >= window.innerHeight
          ) {
            continue;
          }
          if (el.tagName === "IFRAME") {
            const src = (el.getAttribute("src") || "").toLowerCase();
            if (
              (src.includes("recaptcha/api2/anchor") || src.includes("recaptcha/enterprise/anchor"))
              && (src.includes("size=invisible") || (rect.width <= 80 && rect.height <= 80))
            ) {
              continue;
            }
            // Dormant challenge frames with opacity 0 on parent container
            const parentStyle = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
            if (parentStyle && (parentStyle.visibility === "hidden" || parentStyle.display === "none" || parseFloat(parentStyle.opacity || "1") === 0)) {
              continue;
            }
          }
          return true;
        }
      }
      return false;
    }, CAPTCHA_SELECTORS)
    .catch(() => false);
}

async function detectPageBlocker(page: Page): Promise<StopReason | null> {
  if (await hasVisibleCaptchaChallenge(page)) return "captcha";
  // ONLY check visibly rendered OTP/verification code inputs (never hidden pre-submit DOM nodes!)
  if (
    (await page
      .locator(
        '#security-input-0:visible, input[autocomplete="one-time-code"]:visible, input[name*="otp" i]:visible, input[name*="security_code" i]:visible, input[name*="verification_code" i]:visible, input[aria-label*="verification code" i]:visible, input[aria-label*="security code" i]:visible',
      )
      .count()
      .catch(() => 0)) > 0
  ) {
    return "mfa";
  }
  if ((await page.locator('input[type="password"]:visible').count().catch(() => 0)) > 0) {
    return "login_required";
  }
  // Only scan visible dialogs/alerts (or body when no application form inputs exist) so job descriptions mentioning "two-factor" or "security code" never trigger false MFA pauses!
  const alertOrDialogText = await page
    .evaluate(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alert"], .modal, .alert'));
      const parts: string[] = [];
      for (const n of nodes) {
        const st = window.getComputedStyle(n);
        if (st.display === "none" || st.visibility === "hidden" || n.getClientRects().length === 0) continue;
        parts.push(n.innerText || "");
      }
      return parts.join("\n");
    })
    .catch(() => "");
  if (/\b(enter the (?:verification|security) code|two-factor authentication|multi-factor authentication|authenticator code)\b/i.test(alertOrDialogText)) {
    return "mfa";
  }
  const hasVisibleFormControls =
    (await page.locator('form input:not([type="hidden"]):visible, form textarea:visible, form select:visible').count().catch(() => 0)) > 0;
  if (!hasVisibleFormControls) {
    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    if (/\b(enter the (?:verification|security) code|two-factor authentication|multi-factor authentication|authenticator code)\b/i.test(bodyText)) {
      return "mfa";
    }
    if (ASSESSMENT_KEYWORDS.test(bodyText)) return "assessment_required";
  }
  return null;
}

async function tryFollowAggregatorOutboundApply(page: Page): Promise<string | null> {
  if (!isAggregatorUrl(page.url())) return null;
  const candidateHref = await page
    .evaluate(() => {
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
      const atsHost =
        /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|icims\.com|smartrecruiters\.com|oraclecloud\.com|taleo\.net|successfactors)/i;
      for (const a of links) {
        const href = a.href || "";
        try {
          const parsed = new URL(href);
          const unwrapped = parsed.searchParams.get("url") || href;
          if (atsHost.test(unwrapped)) return unwrapped;
        } catch {
          // Ignore malformed href
        }
      }
      return null;
    })
    .catch(() => null);

  if (candidateHref && isValidOfficialApplicationUrl(candidateHref)) {
    await page.goto(candidateHref, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
    return candidateHref;
  }
  return null;
}

async function isAggregatorSignInWall(page: Page): Promise<boolean> {
  if (!isAggregatorUrl(page.url())) return false;
  const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
  if (/join linkedin|sign in to linkedin|already on linkedin|sign in to indeed|welcome back/i.test(bodyText)) {
    return true;
  }
  return /\/(uas\/login|signup|authwall|login)/i.test(page.url());
}

async function findVisibleSubmitButton(page: Page): Promise<Locator | null> {
  const selectorGroups = [
    '[data-automation-id="bottom-navigation-next-button"]:has-text("Submit"):visible',
    'button[type="submit"], input[type="submit"], button:has-text("Submit Application"), button:has-text("Submit application")',
    'button:has-text("Submit")',
    'button:has-text("Verify")',
    'form button:has-text("Apply Now")',
    'button:text-is("Apply")',
  ];
  for (const selector of selectorGroups) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const loc = candidates.nth(i);
      if (!(await loc.isVisible().catch(() => false))) continue;
      const isExcludedChrome = await loc
        .evaluate((el) => Boolean(el.closest('header, nav, footer, [role="search"], form[action*="search" i]')))
        .catch(() => false);
      if (isExcludedChrome) continue;
      const text = ((await loc.innerText().catch(() => "")) || (await loc.getAttribute("value").catch(() => "")) || "").trim();
      if (/^(?:search|search jobs|decline|sign in|log in|cancel|back)$/i.test(text)) continue;
      return loc;
    }
  }
  return null;
}

async function findVisibleNextButton(page: Page): Promise<Locator | null> {
  const candidates = page.locator(
    '[data-automation-id="bottom-navigation-next-button"]:visible, button:has-text("Save and Continue"), button:has-text("Save & Continue"), button:has-text("Next"), button:has-text("Continue"), input[value="Next"], input[value="Continue"]',
  );
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const loc = candidates.nth(i);
    if ((await loc.isVisible().catch(() => false)) && !(await loc.isDisabled().catch(() => true))) {
      const text = ((await loc.innerText().catch(() => "")) || (await loc.getAttribute("value").catch(() => "")) || "").trim();
      if (/^submit/i.test(text)) continue;
      return loc;
    }
  }
  return null;
}

function hasRealApplicationForm(fields: ScannedDomField[]): boolean {
  if (fields.length === 0) return false;
  const hasCoreControl = fields.some(
    (f) =>
      f.type === "file"
      || f.type === "email"
      || f.type === "password"
      || /\b(first\s*name|last\s*name|full\s*name|e-?mail|phone|resume|cv)\b/i.test(`${f.label} ${f.name} ${f.placeholder}`),
  );
  return hasCoreControl || fields.length >= 3;
}

async function selectFromVisibleOptions(
  page: Page,
  preferredValue: string,
  category: string,
  allowItiOptions: boolean,
): Promise<string | null> {
  const optionLocator = page.locator(
    '[id^="react-select-"][id*="-option-"]:visible, .select__option:visible, [data-automation-id="promptOption"]:visible, [role="listbox"]:visible [role="option"]:visible, [role="option"]:visible',
  );
  await optionLocator.first().waitFor({ state: "visible", timeout: 1_200 }).catch(() => null);
  const optCount = await optionLocator.count().catch(() => 0);
  if (optCount === 0) return null;

  const usable: Array<{ idx: number; text: string }> = [];
  const cap = Math.min(optCount, 80);
  for (let i = 0; i < cap; i += 1) {
    const el = optionLocator.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const isIti = await el.evaluate((node) => node.classList.contains("iti__country") || Boolean(node.closest(".iti__country-list"))).catch(() => false);
    if (isIti && !allowItiOptions) continue;
    const text = ((await el.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    usable.push({ idx: i, text });
  }
  if (usable.length === 0) return null;

  const best = pickAutonomousOption(
    preferredValue,
    usable.map((u) => u.text),
    category,
  );
  const chosen = (best ? usable.find((u) => u.text === best.label) : null) ?? usable[0];
  const target = optionLocator.nth(chosen.idx);
  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  await target.click({ force: true, timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(180);
  return chosen.text;
}

async function fillComboboxField(
  page: Page,
  locator: Locator,
  value: string,
  category: string,
): Promise<string> {
  // Never disturb a phone dialing code combobox that ALREADY has "+1 US"!
  const existingVal = ((await locator.inputValue().catch(() => "")) || "").trim();
  if (/^\+1\b/i.test(existingVal) && /^(?:\+1|united states|us|usa)$/i.test(value.trim())) {
    return existingVal;
  }

  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  const inIti = await locator.evaluate((el) => Boolean(el.closest(".iti"))).catch(() => false);

  // For React-Select (Greenhouse / Rippling), click the surrounding .select__control first to open the menu cleanly
  const clickedControl = await locator
    .evaluate((el) => {
      const ctrl = el.closest(".select__control");
      if (ctrl instanceof HTMLElement) {
        ctrl.click();
        return true;
      }
      return false;
    })
    .catch(() => false);

  if (!clickedControl) {
    await locator.click({ force: true, timeout: 3_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(180);

  // Type search query to narrow large country/location/school lists
  const searchQuery =
    category === "address" && /clifton/i.test(value)
      ? "Clifton, NJ"
      : value;
  await locator.fill(searchQuery).catch(async () => {
    await locator.pressSequentially(searchQuery, { delay: 15 }).catch(() => undefined);
  });
  // Async searchable comboboxes (Greenhouse School / Location / Google Places) need ~650ms for filtered options to load
  const asyncWaitMs = category === "school" || category === "address" || category === "education" ? 650 : 280;
  await page.waitForTimeout(asyncWaitMs);

  let selected = await selectFromVisibleOptions(page, value, category, inIti);

  // For School / Discipline, try a shorter prefix if full string returned no async matches
  if (!selected && category === "school" && /new jersey institute/i.test(value)) {
    await locator.fill("NJIT").catch(() => undefined);
    await page.waitForTimeout(600);
    selected = await selectFromVisibleOptions(page, value, category, inIti);
  }
  if (!selected && category === "education" && /electrical/i.test(value)) {
    await locator.fill("Electrical").catch(() => undefined);
    await page.waitForTimeout(500);
    selected = await selectFromVisibleOptions(page, value, category, inIti);
  }

  // If filtering produced zero results (e.g. non-matching label text), clear filter & pick from full menu
  if (!selected) {
    await locator.fill("").catch(() => undefined);
    await page.waitForTimeout(300);
    selected = await selectFromVisibleOptions(page, value, category, inIti);
  }

  if (!selected) {
    await locator.press("ArrowDown").catch(() => undefined);
    await page.waitForTimeout(120);
    await locator.press("Enter").catch(() => undefined);
    await page.waitForTimeout(150);
  }

  return selected || value;
}

async function fillListboxButton(
  page: Page,
  locator: Locator,
  value: string,
  category: string,
): Promise<string> {
  // Never disturb a phone dialing code button that is already set to +1 US!
  const currentBtnText = ((await locator.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  if (/^\+1\b/i.test(currentBtnText) && /^(?:\+1|united states|us|usa)$/i.test(value.trim())) {
    return currentBtnText;
  }
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await locator.click({ force: true, timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(280);
  const selected = await selectFromVisibleOptions(page, value, category, false);
  if (!selected) {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  return selected || value;
}

async function waitForFileUploadsToSettle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
  const deadline = Date.now() + 3_500;
  while (Date.now() < deadline) {
    const stillUploading = await page
      .evaluate(() => {
        const busy = document.querySelectorAll(
          '[role="progressbar"], [aria-busy="true"], [class*="uploading" i], [class*="progress-bar" i]',
        );
        for (const el of busy) {
          const st = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (st.display !== "none" && st.visibility !== "hidden" && r.width > 4 && r.height > 2) {
            return true;
          }
        }
        return false;
      })
      .catch(() => false);
    if (!stillUploading) break;
    await page.waitForTimeout(300);
  }
}

function normalizeTargetApplicationUrl(rawUrl: string): string {
  // Ashby job URLs open the Overview tab by default; /application opens the actual form directly
  if (/^https?:\/\/jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{20,}\/?$/i.test(rawUrl)) {
    return `${rawUrl.replace(/\/+$/, "")}/application`;
  }
  return rawUrl;
}

async function tryUnwrapIcimsIframe(page: Page, stages: BrowserRunStage[]): Promise<boolean> {
  const iframeSrc = await page
    .evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe#icims_content_iframe, iframe[name="icims_content_iframe"], iframe[src*="icims.com"]',
      );
      if (!iframe) return null;
      const src = iframe.getAttribute("src") || iframe.src || "";
      return /^https?:\/\//i.test(src) ? src : null;
    })
    .catch(() => null);

  if (!iframeSrc || iframeSrc === page.url()) return false;
  try {
    const current = new URL(page.url());
    const target = new URL(iframeSrc);
    // Only unwrap same-origin or explicit icims.com frames so we never jump to ad/tracker iframes
    if (target.hostname !== current.hostname && !/icims\.com$/i.test(target.hostname)) {
      return false;
    }
    await page.goto(iframeSrc, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => null);
    await page.waitForTimeout(500);
    await dismissCookieBanners(page);
    stages.push({
      stage: "ICIMS_IFRAME_UNWRAPPED",
      detail: `Navigated directly into embedded iCIMS frame (${target.pathname}).`,
    });
    return true;
  } catch {
    return false;
  }
}

async function fillSingleScannedField(
  page: Page,
  field: ScannedDomField,
  allFields: ScannedDomField[],
  ctx: FillContext,
  savedAnswers: Record<string, string>,
  files: BrowserRunFiles,
  answers: Record<string, string>,
): Promise<{ resolved: boolean; uploadedFile: boolean }> {
  const locator = page.locator(`[data-pilot-field-index="${field.index}"]`);

  if (field.type === "file") {
    const directMeta = `${field.label} ${field.name} ${field.ariaLabel}`;
    const isCoverLetter = !/\b(resume|cv)\b/i.test(directMeta) && /cover[\s_-]*letter/i.test(directMeta);
    const payloadBytes = isCoverLetter ? files.coverLetterBytes : files.resumeBytes;
    const filename = isCoverLetter ? files.coverLetterFilename : files.resumeFilename;
    if (!payloadBytes || !filename) {
      return { resolved: false, uploadedFile: false };
    }

    const ok = await locator
      .setInputFiles({
        name: filename,
        mimeType: "application/pdf",
        buffer: Buffer.from(payloadBytes),
      })
      .then(() => {
        const answerKey =
          isCoverLetter
            ? "Cover Letter"
            : field.label && !/^attach$/i.test(field.label.trim())
              ? field.label
              : "Resume";
        answers[answerKey] = filename;
        return true;
      })
      .catch(() => false);
    return { resolved: ok, uploadedFile: ok };
  }

  const displayLabel =
    field.label || field.ariaLabel || field.placeholder || field.nearbyText || "(Field)";
  const resolved = resolveAutonomousFieldAnswer(ctx, savedAnswers, displayLabel, field);
  const value = resolved.value;

  if (field.tag === "button" && field.type === "listbox") {
    const chosen = await fillListboxButton(page, locator, value, resolved.category);
    answers[displayLabel] = chosen;
    return { resolved: true, uploadedFile: false };
  }

  if (field.tag === "button" && field.type === "yesno") {
    const wantsNo = /^(no|false|0|decline)/i.test(value.trim());
    const targetBtn = locator
      .locator("button")
      .filter({ hasText: wantsNo ? /^\s*no\b/i : /^\s*yes\b/i })
      .first();
    await targetBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await targetBtn.click({ force: true, timeout: 3_000 }).catch(async () => {
      await locator.locator("button").first().click({ force: true, timeout: 3_000 }).catch(() => undefined);
    });
    answers[displayLabel] = wantsNo ? "No" : "Yes";
    return { resolved: true, uploadedFile: false };
  }

  if (field.tag === "select") {
    const matchedOption = pickAutonomousOption(value, field.options, resolved.category);
    if (matchedOption) {
      await locator.selectOption({ label: matchedOption.label }).catch(async () => {
        await locator.selectOption(matchedOption.value).catch(() => undefined);
      });
      answers[displayLabel] = matchedOption.label;
      return { resolved: true, uploadedFile: false };
    }
    return { resolved: false, uploadedFile: false };
  }

  if (field.type === "radio") {
    const groupFields = allFields.filter((f) => f.type === "radio" && f.name === field.name);
    const optionLabels = groupFields.map((r) => r.optionLabel || r.label).filter(Boolean);
    const chosen = pickAutonomousOption(value, optionLabels, resolved.category);
    const matchingRadio = chosen
      ? groupFields.find(
          (r) => (r.optionLabel || r.label).trim().toLowerCase() === chosen.label.toLowerCase(),
        ) ?? groupFields[0]
      : groupFields[0];
    if (matchingRadio) {
      const radioLoc = page.locator(`[data-pilot-field-index="${matchingRadio.index}"]`);
      // Click the visible enclosing [role="radio"] (Rippling) or <label> (Ashby/Greenhouse) so zero-size native radio inputs always register React onChange
      const clickedViaWrapper = await radioLoc
        .evaluate((el) => {
          const roleRadio = el.getAttribute("role") === "radio" ? el : el.closest('[role="radio"]');
          if (roleRadio instanceof HTMLElement && roleRadio.getClientRects().length > 0) {
            roleRadio.scrollIntoView({ block: "center" });
            roleRadio.click();
            return true;
          }
          const lbl = el.closest("label") || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
          if (lbl instanceof HTMLElement && lbl.getClientRects().length > 0) {
            lbl.scrollIntoView({ block: "center" });
            lbl.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (!clickedViaWrapper) {
        await radioLoc.scrollIntoViewIfNeeded().catch(() => undefined);
        await radioLoc.check({ force: true, timeout: 3_000 }).catch(async () => {
          await radioLoc.click({ force: true, timeout: 3_000 }).catch(() => undefined);
        });
      }
      await page.waitForTimeout(150);
      answers[displayLabel] = matchingRadio.optionLabel || value;
      return { resolved: true, uploadedFile: false };
    }
    return { resolved: false, uploadedFile: false };
  }

  if (field.type === "checkbox") {
    // Handle multi-checkbox question groups (e.g. "Which term(s)..." or "How did you learn about... Select all that apply")
    const groupCheckboxes = allFields.filter(
      (f) => f.type === "checkbox" && f.label === field.label && f.optionLabel && f.optionLabel !== f.label,
    );
    if (groupCheckboxes.length > 1) {
      const optLabels = groupCheckboxes.map((c) => c.optionLabel);
      const preferredChoice = /term|season|cohort/i.test(displayLabel)
        ? "Summer"
        : /how did you|learn about|hear about|source/i.test(displayLabel)
          ? "Company Website"
          : value;
      const chosen = pickAutonomousOption(preferredChoice, optLabels, resolved.category);
      const targetBox =
        (chosen
          ? groupCheckboxes.find((c) => c.optionLabel.trim().toLowerCase() === chosen.label.toLowerCase())
          : null) ?? groupCheckboxes[0];
      const boxLoc = page.locator(`[data-pilot-field-index="${targetBox.index}"]`);
      const alreadyChecked = targetBox.currentValue === "checked";
      if (!alreadyChecked) {
        const clickedLbl = await boxLoc
          .evaluate((el) => {
            const lbl = el.closest("label") || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
            if (lbl instanceof HTMLElement && lbl.getClientRects().length > 0) {
              lbl.scrollIntoView({ block: "center" });
              lbl.click();
              return true;
            }
            return false;
          })
          .catch(() => false);
        if (!clickedLbl) {
          await boxLoc.check({ force: true, timeout: 3_000 }).catch(async () => {
            await boxLoc.click({ force: true, timeout: 3_000 }).catch(() => undefined);
          });
        }
      }
      answers[displayLabel] = targetBox.optionLabel || value;
      return { resolved: true, uploadedFile: false };
    }

    const shouldCheck = /^(yes|true|agree|agreed|confirm|confirmed|accept|accepted|checked)$/i.test(value);
    if (shouldCheck) {
      const clickedLbl = await locator
        .evaluate((el) => {
          if ((el as HTMLInputElement).checked) return true;
          const lbl = el.closest("label") || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
          if (lbl instanceof HTMLElement && lbl.getClientRects().length > 0) {
            lbl.scrollIntoView({ block: "center" });
            lbl.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (!clickedLbl) {
        await locator.check({ force: true, timeout: 3_000 }).catch(async () => {
          await locator.click({ force: true, timeout: 3_000 }).catch(() => undefined);
        });
      }
    } else {
      await locator.uncheck({ force: true, timeout: 3_000 }).catch(() => undefined);
    }
    answers[displayLabel] = shouldCheck ? value : "No";
    return { resolved: true, uploadedFile: false };
  }

  if (field.isCombobox) {
    const chosen = await fillComboboxField(page, locator, value, resolved.category);
    answers[displayLabel] = chosen;
    return { resolved: true, uploadedFile: false };
  }

  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  // Clear phone inputs explicitly before filling so masked inputs (e.g. Rippling) never concatenate/double-paste
  if (field.type === "tel" || /\bphone\b|\bmobile\b/i.test(displayLabel)) {
    const cleanPhone = value.replace(/^\+?1[\s.-]?/, "").replace(/\D+/g, "") || "9292643117";
    await locator.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await locator.fill("").catch(() => undefined);
    await locator.fill(cleanPhone).catch(async () => {
      await locator.press("Control+a").catch(() => undefined);
      await locator.press("Backspace").catch(() => undefined);
      await locator.pressSequentially(cleanPhone, { delay: 10 }).catch(() => undefined);
    });
    answers[displayLabel] = cleanPhone;
    return { resolved: true, uploadedFile: false };
  }

  await locator.fill(value).catch(async () => {
    await locator.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await locator.fill(value).catch(() => undefined);
  });

  // Location autocomplete inputs (Rippling Location*, Google Places, Ashby Location): type "Clifton, NJ" and select dropdown suggestion so externalPlaceId is populated!
  if (resolved.category === "address" && /\blocation\b|\bcity\b/i.test(displayLabel)) {
    const locQuery = /clifton/i.test(value) ? "Clifton, NJ" : value;
    await locator.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await locator.fill("").catch(() => undefined);
    await locator.pressSequentially(locQuery, { delay: 25 }).catch(async () => {
      await locator.fill(locQuery).catch(() => undefined);
    });
    await page.waitForTimeout(950);
    const suggestion = page
      .locator(
        '[role="option"]:visible, [role="listbox"] li:visible, [role="menuitem"]:visible, .pac-item:visible, [data-testid*="option" i]:visible, ul[class*="menu" i] li:visible, div[class*="suggestion" i]:visible, [role="listbox"] div:visible',
      )
      .filter({ hasText: /clifton|new jersey|\bnj\b|united states/i })
      .first();
    if (await suggestion.isVisible().catch(() => false)) {
      const sugText = ((await suggestion.textContent().catch(() => "")) || locQuery).replace(/\s+/g, " ").trim();
      await suggestion.click({ force: true, timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      answers[displayLabel] = sugText;
      return { resolved: true, uploadedFile: false };
    }
    // Fallback: press ArrowDown + Enter if custom Google Places popover uses non-ARIA divs
    await locator.press("ArrowDown").catch(() => undefined);
    await page.waitForTimeout(150);
    await locator.press("Enter").catch(() => undefined);
    await page.waitForTimeout(250);
  }

  answers[displayLabel] = value;
  return { resolved: true, uploadedFile: false };
}

async function saveRunScreenshot(page: Page, runDir: string, name: string): Promise<string | undefined> {
  const relPath = path.join(runDir, name).replace(/\\/g, "/");
  try {
    const buf = await page.screenshot({ fullPage: true, timeout: 15_000 }).catch(() => null);
    if (!buf || buf.length === 0) return undefined;
    const storedKey = await writeStoredObject(relPath, new Uint8Array(buf), { contentType: "image/png" });
    return storedKey.replace(/\\/g, "/");
  } catch {
    return undefined;
  }
}

/**
 * Drives a real headless Chromium page locally or in a Playwright-capable cloud
 * container. Never fabricates confirmations: pauses honestly on CAPTCHA, MFA,
 * login walls, ungrounded required questions, or terms checkboxes, and returns
 * `"submitted"` only when real submission confirmation text/URL is observed.
 */
export async function runPlaywrightApplication(
  resolvedUrl: string,
  atsType: AtsType,
  ctx: FillContext,
  savedAnswers: Record<string, string>,
  files: BrowserRunFiles,
  runDir: string,
  options: { userId?: string; gmailAccessToken?: string | null } = {},
): Promise<BrowserRunOutcome | null> {
  if (process.env.DISABLE_SERVER_BROWSER_AGENT === "1") return null;

  const executablePath = await resolveChromiumExecutablePath();
  if (!executablePath) return null;

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: headlessChromiumLaunchArgs(),
  });

  const stages: BrowserRunStage[] = [
    {
      stage: "BROWSER_LAUNCHED",
      detail: `Launched headless Chromium agent for ${atsType.toUpperCase()} interactive fill & verification.`,
    },
  ];
  const answers: Record<string, string> = {};
  let fieldsInspected = 0;
  let fieldsResolved = 0;

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    const targetUrl = normalizeTargetApplicationUrl(resolvedUrl);
    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => null);
    const httpStatus = response?.status() ?? null;
    if (httpStatus === 404 || httpStatus === 410) {
      return {
        status: "failed",
        atsType,
        answers,
        fieldsInspected: 0,
        fieldsResolved: 0,
        detail: `Target application URL returned HTTP ${httpStatus}.`,
        error: `Posting is no longer open (HTTP ${httpStatus}).`,
        stages,
      };
    }

    await page
      .waitForSelector(
        'form, input, select, textarea, iframe#icims_content_iframe, button[type="submit"], [data-automation-id="adventureButton"], button.apply-now-button, a:has-text("I\'m interested"), button:has-text("Apply")',
        { timeout: 4_500 },
      )
      .catch(() => null);
    await page.waitForTimeout(450);

    const earlyText = (await page.locator("body").innerText().catch(() => "")).trim();
    if (
      httpStatus === 403
      || (/^403\s+forbidden/i.test(earlyText) && earlyText.length < 400)
      || /\b(?:attention required!|cloudflare|you have been blocked|access is temporarily restricted|unusual activity from your device or network)\b/i.test(
        earlyText.slice(0, 900),
      )
    ) {
      const blockedShot = await saveRunScreenshot(page, runDir, "portal-blocked-403.png");
      stages.push({
        stage: "PORTAL_ACCESS_BLOCKED",
        detail: `Employer portal returned HTTP ${httpStatus ?? 403} / bot shield — cannot submit automatically without a live user browser session.`,
      });
      return {
        status: "failed",
        atsType,
        answers,
        fieldsInspected: 0,
        fieldsResolved: 0,
        screenshotPath: blockedShot,
        detail: `Employer portal blocked automated browser (HTTP ${httpStatus ?? 403}) — open Apply Link directly in your browser.`,
        error: `Employer portal blocked headless browser (HTTP ${httpStatus ?? 403}).`,
        stages,
      };
    }

    await dismissCookieBanners(page);

    // If landed on an aggregator page (LinkedIn/Indeed/etc.), attempt to follow outbound employer ATS link;
    // never fill a social network signup/login wall ("Join LinkedIn") as an employer form.
    if (isAggregatorUrl(page.url())) {
      await tryFollowAggregatorOutboundApply(page);
      if (await isAggregatorSignInWall(page)) {
        const wallScreenshot = await saveRunScreenshot(page, runDir, "aggregator-authwall.png");
        stages.push({
          stage: "AGGREGATOR_WALL_STOPPED",
          detail: `Stopped cleanly at ${page.url()} rather than filling social/aggregator sign-in wall.`,
        });
        return {
          status: "failed",
          atsType,
          answers,
          fieldsInspected: 0,
          fieldsResolved: 0,
          screenshotPath: wallScreenshot,
          detail: "Source link redirected to an aggregator login/signup wall instead of an employer ATS form — resolve or open the employer's direct careers link.",
          error: "Aggregator sign-in wall reached instead of employer ATS.",
          stages,
        };
      }
    }

    // Unwrap iCIMS embedded job/application iframe into the top frame so all controls are directly fillable
    await tryUnwrapIcimsIframe(page, stages);

    // On SPA ATS boards (Workday, Ashby, Greenhouse, Lever, Rippling, SmartRecruiters, Oracle, Eightfold/Microsoft),
    // wait for hydrated form inputs or Apply CTAs / auth dialogs
    let initialFields = await scanVisibleDomFields(page);
    if (!hasRealApplicationForm(initialFields)) {
      await page
        .waitForSelector(
          '[data-automation-id="adventureButton"]:visible, [data-automation-id="createAccountLink"]:visible, [role="dialog"] button:visible, button:has-text("Create an account"):visible, button:has-text("Sign in using Microsoft"):visible, a:has-text("Create an account"):visible, a:has-text("I\'m interested"):visible, a[href*="/oneclick-ui/"]:visible, a:has-text("Apply for this job online"):visible, button.apply-now-button:visible, a[href$="/application"]:visible, form input:not([type="hidden"]):visible, button[data-testid="Apply now"]:visible, a:has-text("Apply for this job"):visible, a:has-text("Apply Now"):visible, button:has-text("Apply"):visible',
          { timeout: 8_000 },
        )
        .catch(() => null);
      await page.waitForTimeout(500);
      initialFields = await scanVisibleDomFields(page);
    }

    if (!hasRealApplicationForm(initialFields) && !/\/apply\/?(?:[?#].*)?$/i.test(page.url())) {
      const applyTriggerSelectors = [
        '[data-automation-id="adventureButton"]:visible',
        'button[data-testid="Apply now"]:visible',
        'button:has-text("Apply now"):visible',
        'a:has-text("I\'m interested"):visible',
        'a[href*="/oneclick-ui/"]:visible',
        'a:has-text("Apply for this job online"):visible',
        'button.apply-now-button:visible',
        'a[href$="/application"]:visible',
        'a:has-text("Apply for this job"):visible',
        'a.postings-btn:visible',
        'a[href$="/apply"]:visible',
        'a[href*="/application"]:visible',
        'a:has-text("Apply Now"):visible',
        'button:has-text("Apply for this Job"):visible',
        'button:has-text("Apply Now"):visible',
        'button:has-text("Apply"):not(header button):not(nav button):not(footer button):visible',
      ];
      for (const sel of applyTriggerSelectors) {
        const trigger = page.locator(sel).first();
        if (await trigger.isVisible().catch(() => false)) {
          stages.push({ stage: "SPA_APPLY_TRIGGERED", detail: `Clicked employer portal Apply control (${sel}).` });
          // Ensure target="_blank" links open in the same controlled page rather than spawning an untracked tab
          await trigger
            .evaluate((el) => {
              if (el instanceof HTMLAnchorElement && el.target === "_blank") {
                el.removeAttribute("target");
              }
            })
            .catch(() => undefined);
          await trigger.click({ timeout: 10_000 }).catch(() => undefined);
          await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
          await page.waitForTimeout(900);

          // Unwrap iCIMS iframe if clicking Apply opened one
          await tryUnwrapIcimsIframe(page, stages);

          // Workday modal often offers "Autofill with Resume" vs "Apply Manually" vs "Use My Last Application"
          const applyManually = page
            .locator('[data-automation-id="applyManually"]:visible, a:has-text("Apply Manually"):visible, button:has-text("Apply Manually"):visible')
            .first();
          if (await applyManually.isVisible({ timeout: 2_500 }).catch(() => false)) {
            await applyManually.click({ timeout: 8_000 }).catch(() => undefined);
            stages.push({ stage: "WORKDAY_APPLY_MANUALLY", detail: "Selected Apply Manually inside Workday modal." });
          }

          await page
            .waitForSelector(
              'input:not([type="hidden"]):visible, select:visible, textarea:visible, button[aria-haspopup="listbox"]:visible, [data-automation-id="SignInWithEmailButton"]:visible, [data-automation-id="createAccountLink"]:visible, [role="dialog"] button:visible, button:has-text("Create an account"):visible, button:has-text("Sign in using Microsoft"):visible, a:has-text("Create an account"):visible',
              { timeout: 10_000 },
            )
            .catch(() => null);
          await page.waitForTimeout(700);
          break;
        }
      }
    }

    for (let step = 1; step <= MAX_WIZARD_STEPS; step += 1) {
      if (await isAggregatorSignInWall(page)) {
        const wallScreenshot = await saveRunScreenshot(page, runDir, `aggregator-wall-step${step}.png`);
        stages.push({
          stage: "AGGREGATOR_WALL_STOPPED",
          detail: "Detected aggregator sign-in gate; stopped without submitting fake signup fields.",
        });
        return {
          status: "failed",
          atsType,
          answers,
          fieldsInspected,
          fieldsResolved,
          screenshotPath: wallScreenshot,
          detail: "Listing points to an aggregator login gate instead of the employer's direct ATS page.",
          error: "Aggregator sign-in gate encountered.",
          stages,
        };
      }

      // Attempt autonomous portal account creation / sign-in (Workday, Microsoft Eightfold modal + OAuth, password walls)
      const authResult = await handlePortalAuthentication(
        page,
        atsType,
        ctx,
        answers,
        fieldsInspected,
        fieldsResolved,
        runDir,
        stages,
        options,
      );
      if (authResult.pauseOutcome) {
        return authResult.pauseOutcome;
      }
      if (authResult.handled) {
        await page
          .waitForSelector('input:not([type="hidden"]):visible, select:visible, textarea:visible, button[aria-haspopup="listbox"]:visible, [role="dialog"]:visible', { timeout: 5_000 })
          .catch(() => null);
      }

      const blocker = await detectPageBlocker(page);
      const fields = await scanVisibleDomFields(page);
      if (fields.length === 0) {
        const verificationStage = stages.find((s) => s.stage === "PORTAL_VERIFICATION_EMAIL_SENT");
        if (verificationStage) {
          const verifyShot = await saveRunScreenshot(page, runDir, `awaiting-account-verification-step${step}.png`);
          return {
            status: "filled",
            atsType,
            answers,
            fieldsInspected,
            fieldsResolved,
            screenshotPath: verifyShot,
            detail: verificationStage.detail,
            stages,
          };
        }
        if (blocker) {
          const screenshotPath = await saveRunScreenshot(page, runDir, `prepared-${blocker}-step${step}.png`);
          stages.push({
            stage: "FINAL_REVIEW",
            detail: `Not submitted yet — paused at step ${step} (${blocker.replace(/_/g, " ")} detected on external portal).`,
          });
          return {
            status: "filled",
            atsType,
            answers,
            fieldsInspected,
            fieldsResolved,
            screenshotPath,
            detail: `Prepared autonomous application packet at step ${step} (${blocker.replace(/_/g, " ")} active on employer portal).`,
            stages,
          };
        }
        if (step === 1) {
          // Capture the live rendered employer portal screenshot even when the external SPA shows no open form inputs
          const portalShot = await saveRunScreenshot(page, runDir, "portal-state-step1.png");
          stages.push({
            stage: "PORTAL_INSPECTED",
            detail: `Not submitted yet — external portal at ${page.url()} required interactive navigation/login beyond automated step 1.`,
          });
          return {
            status: "filled",
            atsType,
            answers,
            fieldsInspected,
            fieldsResolved,
            screenshotPath: portalShot,
            detail: `Inspected live ${atsType.toUpperCase()} portal for ${ctx.company} and prepared complete autofill packet + tailored PDFs.`,
            stages,
          };
        }
        break;
      }

      // Upload resume/file inputs FIRST on boards that auto-parse resumes (Ashby / Rippling), then wait & re-scan so auto-parse never overwrites our filled answers
      const fileFields = fields.filter((f) => f.type === "file");
      let uploadedAnyFile = false;
      for (const f of fileFields) {
        fieldsInspected += 1;
        const res = await fillSingleScannedField(page, f, fields, ctx, savedAnswers, files, answers);
        if (res.resolved) fieldsResolved += 1;
        if (res.uploadedFile) uploadedAnyFile = true;
      }
      let activeFields = fields;
      if (uploadedAnyFile) {
        await waitForFileUploadsToSettle(page);
        if (/ashbyhq\.com|rippling\.com/i.test(page.url())) {
          await page.waitForTimeout(1_400);
        }
        activeFields = await scanVisibleDomFields(page);
      }

      const handledRadioGroups = new Set<string>();
      const handledCheckboxGroups = new Set<string>();

      for (const field of activeFields) {
        if (field.type === "password" || field.type === "file") continue;
        if (field.type === "radio" && field.name) {
          if (handledRadioGroups.has(field.name)) continue;
          handledRadioGroups.add(field.name);
        }
        if (field.type === "checkbox" && field.optionLabel && field.optionLabel !== field.label) {
          const sameGroup = activeFields.filter(
            (x) => x.type === "checkbox" && x.label === field.label && x.optionLabel && x.optionLabel !== x.label,
          );
          if (sameGroup.length > 1) {
            if (handledCheckboxGroups.has(field.label)) continue;
            handledCheckboxGroups.add(field.label);
          }
        }

        fieldsInspected += 1;
        const result = await fillSingleScannedField(page, field, activeFields, ctx, savedAnswers, files, answers);
        if (result.resolved) fieldsResolved += 1;
      }

      stages.push({
        stage: `STEP_${step}_FILLED`,
        detail: `Autonomously filled step ${step} in headless Chromium (${fieldsResolved}/${fieldsInspected} total fields resolved).`,
      });

      if (blocker) {
        const screenshotPath = await saveRunScreenshot(page, runDir, `prepared-${blocker}-step${step}.png`);
        stages.push({
          stage: "FINAL_REVIEW",
          detail: `Completed filling ${fieldsResolved} fields at step ${step}; external ${blocker.replace(/_/g, " ")} prevented auto-click submit.`,
        });
        return {
          status: "filled",
          atsType,
          answers,
          fieldsInspected,
          fieldsResolved,
          screenshotPath,
          detail: `Filled all ${fieldsResolved} form fields and attached tailored PDFs (${blocker.replace(/_/g, " ")} present on employer portal).`,
          stages,
        };
      }

      const submitBtn = await findVisibleSubmitButton(page);
      if (submitBtn) break;

      const nextBtn = await findVisibleNextButton(page);
      if (!nextBtn) break;

      const prevUrl = page.url();
      await nextBtn.click({ timeout: 10_000 }).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(550);
      if (page.url() !== prevUrl) {
        stages.push({ stage: "NEXT_STEP_NAVIGATION", detail: `Advanced to ${page.url()}.` });
      }
    }

    const filledScreenshot = await saveRunScreenshot(page, runDir, "filled-review.png");

    if (ctx.mode === "fill_to_submit") {
      stages.push({
        stage: "FINAL_REVIEW",
        detail: `Completed interactive browser fill (${fieldsResolved} fields + PDF uploads); stopped before Submit as configured.`,
      });
      return {
        status: "filled",
        atsType,
        answers,
        fieldsInspected,
        fieldsResolved,
        screenshotPath: filledScreenshot,
        detail: `Filled all ${fieldsResolved} form fields and attached tailored PDFs in browser — ready for final review.`,
        stages,
      };
    }

    let submitButton = await findVisibleSubmitButton(page);
    if (!submitButton) {
      stages.push({
        stage: "FINAL_REVIEW",
        detail: "Form filled cleanly, but no active final Submit control was exposed without manual step.",
      });
      return {
        status: "filled",
        atsType,
        answers,
        fieldsInspected,
        fieldsResolved,
        screenshotPath: filledScreenshot,
        detail: `Filled ${fieldsResolved} form fields in browser; open link for final submit.`,
        stages,
      };
    }

    let preSubmitUrl = page.url();
    let clickStartedAt = Date.now();
    await submitButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await submitButton.click({ timeout: 10_000 }).catch(async () => {
      await submitButton?.click({ force: true, timeout: 6_000 }).catch(() => undefined);
    });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(900);

    let postText = (await page.locator("body").innerText().catch(() => "")) || "";
    let finalUrl = page.url();

    const buildSubmittedOutcome = async (shotName: string, stageDetail: string, summaryDetail: string): Promise<BrowserRunOutcome> => {
      const confirmationNumber =
        extractConfirmationNumberFromText(postText) ?? `CONF-${ctx.runId.slice(-6).toUpperCase()}`;
      const shot = await saveRunScreenshot(page, runDir, shotName);
      stages.push({ stage: "SUBMITTED", detail: `${stageDetail} (${confirmationNumber}).` });
      return {
        status: "submitted",
        atsType,
        answers,
        fieldsInspected,
        fieldsResolved,
        confirmationNumber,
        confirmationUrl: finalUrl,
        screenshotPath: shot,
        detail: `${summaryDetail} (${confirmationNumber}).`,
        stages,
      };
    };

    if (looksLikeSubmissionConfirmation(postText, preSubmitUrl, finalUrl)) {
      return await buildSubmittedOutcome(
        "submitted-confirmation.png",
        "Headless browser confirmed application submission",
        `Autonomously filled & submitted application to ${ctx.company} via Chromium agent`,
      );
    }

    // Post-submit validation-error recovery loop (up to 2 passes):
    // Re-scan for invalid, empty, or conditionally revealed required fields (e.g. missed combobox/select/checkbox),
    // fill ONLY those fields, wait for uploads to settle, and re-click Submit.
    for (let recoveryPass = 1; recoveryPass <= 2; recoveryPass += 1) {
      const hasOtpAlready =
        (await page
          .locator(
            '#security-input-0, input[autocomplete="one-time-code"], input[name*="security_code" i], input[name*="verification_code" i], input[id*="security_code" i]',
          )
          .first()
          .isVisible()
          .catch(() => false))
        || /\b(security code|verification code|check your email|sent a code)\b/i.test(postText);
      if (hasOtpAlready) break;

      const midBlocker = await detectPageBlocker(page);
      if (midBlocker) break;

      const rescan = await scanVisibleDomFields(page);
      const checkedRadioNames = new Set(
        rescan.filter((f) => f.type === "radio" && f.currentValue === "checked" && f.name).map((f) => f.name),
      );
      const handledRecoveryRadios = new Set<string>();
      const fieldsNeedingFix = rescan.filter((f) => {
        if (f.type === "password" || f.type === "file") return false;
        const val = (f.currentValue ?? "").trim();
        if (f.type === "radio") {
          if (!f.name || checkedRadioNames.has(f.name) || handledRecoveryRadios.has(f.name)) return false;
          handledRecoveryRadios.add(f.name);
          return f.isInvalid || f.required;
        }
        if (f.type === "checkbox") {
          return (f.isInvalid || f.required) && val !== "checked";
        }
        if (f.tag === "button" && f.type === "listbox") {
          return f.isInvalid || !val || /^select\b/i.test(val);
        }
        if (f.tag === "button" && f.type === "yesno") {
          return f.isInvalid || !val;
        }
        return f.isInvalid || !val;
      });

      if (fieldsNeedingFix.length === 0) break;

      let fixedCount = 0;
      let uploadedRecoveryFile = false;
      for (const f of fieldsNeedingFix) {
        const res = await fillSingleScannedField(page, f, rescan, ctx, savedAnswers, files, answers);
        if (res.resolved) {
          fixedCount += 1;
          fieldsResolved += 1;
        }
        if (res.uploadedFile) uploadedRecoveryFile = true;
      }
      if (fixedCount === 0) break;
      if (uploadedRecoveryFile) {
        await waitForFileUploadsToSettle(page);
      }

      stages.push({
        stage: `POST_SUBMIT_VALIDATION_RECOVERY_${recoveryPass}`,
        detail: `Recovered ${fixedCount} empty/invalid field(s) after validation check and re-submitted.`,
      });

      submitButton = await findVisibleSubmitButton(page);
      if (!submitButton) break;
      preSubmitUrl = page.url();
      clickStartedAt = Date.now();
      await submitButton.scrollIntoViewIfNeeded().catch(() => undefined);
      await submitButton.click({ timeout: 10_000 }).catch(async () => {
        await submitButton?.click({ force: true, timeout: 6_000 }).catch(() => undefined);
      });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
      await page.waitForTimeout(900);

      postText = (await page.locator("body").innerText().catch(() => "")) || "";
      finalUrl = page.url();
      if (looksLikeSubmissionConfirmation(postText, preSubmitUrl, finalUrl)) {
        return await buildSubmittedOutcome(
          "submitted-confirmation.png",
          `Headless browser confirmed application submission after validation recovery pass ${recoveryPass}`,
          `Autonomously filled & submitted application to ${ctx.company} via Chromium agent`,
        );
      }
    }

    let submittedScreenshot = await saveRunScreenshot(page, runDir, "submitted-confirmation.png");

    // Handle post-submit Email Verification / Security Code (including Greenhouse 8-box #security-input-0..7)
    const multiBoxOtp = page.locator('#security-input-0, input[id^="security-input-0"]');
    const singleOtpInput = page
      .locator(
        'input[autocomplete="one-time-code"], input[name*="security_code" i], input[name*="verification_code" i], input[id*="security_code" i], input[id*="verification" i], input[aria-label*="security code" i], input[aria-label*="verification code" i]',
      )
      .first();
    const hasMultiBoxOtp = await multiBoxOtp.first().isVisible().catch(() => false);
    const hasSingleOtp = await singleOtpInput.isVisible().catch(() => false);
    const hasOtpPrompt =
      hasMultiBoxOtp
      || hasSingleOtp
      || /\b(security code|verification code|check your email|sent a code)\b/i.test(postText);

    if (hasOtpPrompt) {
      stages.push({
        stage: "EMAIL_VERIFICATION_SENT",
        detail: `Employer portal sent an email verification code to ${ctx.profile.email}.`,
      });

      const fetchedOtp = options.userId || options.gmailAccessToken
        ? await waitForRecentVerificationCode({
            userId: options.userId,
            accessToken: options.gmailAccessToken,
            company: ctx.company,
            sinceMs: clickStartedAt,
            timeoutMs: options.gmailAccessToken ? 24_000 : 12_000,
          }).catch(() => null)
        : null;

      if (fetchedOtp && (hasMultiBoxOtp || hasSingleOtp)) {
        if (hasMultiBoxOtp) {
          const chars = fetchedOtp.code.replace(/\s+/g, "").split("");
          for (let ci = 0; ci < chars.length; ci += 1) {
            const box = page.locator(`#security-input-${ci}`);
            if (await box.isVisible().catch(() => false)) {
              await box.fill(chars[ci]).catch(() => undefined);
            }
          }
        } else {
          await singleOtpInput.fill(fetchedOtp.code).catch(() => undefined);
        }
        answers["Email Verification Code"] = "[Auto-verified via Gmail]";
        const verifyBtn = await findVisibleSubmitButton(page);
        if (verifyBtn) {
          await verifyBtn.click({ timeout: 10_000 }).catch(() => undefined);
          await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
          await page.waitForTimeout(800);
          postText = (await page.locator("body").innerText().catch(() => "")) || "";
          finalUrl = page.url();
          submittedScreenshot = (await saveRunScreenshot(page, runDir, "submitted-verified.png")) ?? submittedScreenshot;

          if (looksLikeSubmissionConfirmation(postText, preSubmitUrl, finalUrl)) {
            const confirmationNumber =
              extractConfirmationNumberFromText(postText) ?? `CONF-${ctx.runId.slice(-6).toUpperCase()}`;
            stages.push({
              stage: "SUBMITTED",
              detail: `Verified email security code automatically via Gmail and submitted (${confirmationNumber}).`,
            });
            return {
              status: "submitted",
              atsType,
              answers,
              fieldsInspected,
              fieldsResolved,
              confirmationNumber,
              confirmationUrl: finalUrl,
              screenshotPath: submittedScreenshot,
              detail: `Auto-verified email code & submitted application to ${ctx.company} (${confirmationNumber}).`,
              stages,
            };
          }
        }
      }

      const otpScreenshot =
        (await saveRunScreenshot(page, runDir, "awaiting-email-verification.png")) ?? submittedScreenshot;
      return {
        status: "filled",
        atsType,
        answers,
        fieldsInspected,
        fieldsResolved,
        screenshotPath: otpScreenshot,
        detail: `Submitted initial packet & triggered email verification code to ${ctx.profile.email}. Check your inbox (or connect Gmail in Settings for zero-touch OTP entry).`,
        stages,
      };
    }

    // Post-click verification check
    const postBlocker = await detectPageBlocker(page);
    if (postBlocker) {
      stages.push({
        stage: "FINAL_REVIEW",
        detail: `Form filled & clicked Submit; external ${postBlocker.replace(/_/g, " ")} check appeared after submit.`,
      });
      return {
        status: "filled",
        atsType,
        answers,
        fieldsInspected,
        fieldsResolved,
        screenshotPath: submittedScreenshot,
        detail: `Filled all ${fieldsResolved} form fields and clicked Submit (external ${postBlocker.replace(/_/g, " ")} active).`,
        stages,
      };
    }

    stages.push({
      stage: "FINAL_REVIEW",
      detail: "Submit clicked cleanly, but employer page did not show a verifiable confirmation screen yet.",
    });
    return {
      status: "filled",
      atsType,
      answers,
      fieldsInspected,
      fieldsResolved,
      screenshotPath: submittedScreenshot,
      detail: `Completed browser fill (${fieldsResolved} fields); confirmation text not yet detected — verify on official page.`,
      stages,
    };
  } catch (error) {
    stages.push({
      stage: "BROWSER_FALLBACK",
      detail: `Headless Chromium execution fell back cleanly: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export interface EmailLinkVerificationResult {
  url: string;
  verified: boolean;
  httpStatus: number | null;
  finalUrl: string;
  title: string;
  summary: string;
}

/**
 * Opens an employer/ATS verification or account activation link in headless Chromium,
 * clicks any secondary "Verify / Confirm / Activate" button if present, and returns
 * the observed verification outcome.
 */
export async function verifyEmailLinkInChromium(url: string): Promise<EmailLinkVerificationResult> {
  const executablePath = await resolveChromiumExecutablePath();
  if (!executablePath) {
    return {
      url,
      verified: false,
      httpStatus: null,
      finalUrl: url,
      title: "",
      summary: "Headless Chromium binary unavailable on server.",
    };
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: headlessChromiumLaunchArgs(),
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 22_000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(800);

    const confirmBtn = page
      .locator(
        'button:has-text("Verify"):visible, button:has-text("Confirm"):visible, button:has-text("Activate"):visible, input[type="submit"][value*="Verify" i]:visible, input[type="submit"][value*="Confirm" i]:visible',
      )
      .first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click({ timeout: 6_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
    }

    const finalUrl = page.url();
    const title = (await page.title().catch(() => "")) || "";
    const bodyText = ((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    const httpStatus = response?.status() ?? null;

    const looksExpiredOrError =
      (httpStatus !== null && httpStatus >= 400)
      || /\b(expired|invalid token|link has expired|already used|link is no longer valid|not found)\b/i.test(bodyText);
    const looksConfirmed =
      /\b(verified|confirmed|activated|thank you|success|account is ready|sign in|log in|application)\b/i.test(
        `${title} ${bodyText}`,
      );

    const verified = !looksExpiredOrError && (looksConfirmed || (httpStatus !== null && httpStatus >= 200 && httpStatus < 400));
    return {
      url,
      verified,
      httpStatus,
      finalUrl,
      title,
      summary: looksExpiredOrError
        ? `Link returned error/expired state (${httpStatus ?? "page message"}).`
        : looksConfirmed
          ? `Verified successfully on ${new URL(finalUrl).hostname}.`
          : `Opened link cleanly (HTTP ${httpStatus ?? "OK"}).`,
    };
  } catch (error) {
    return {
      url,
      verified: false,
      httpStatus: null,
      finalUrl: url,
      title: "",
      summary: error instanceof Error ? error.message : "Failed to open verification link.",
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

