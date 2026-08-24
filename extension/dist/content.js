// Internship Pilot Autofill — isolated Manifest V3 content script.
// Values come only from the authenticated local backend. This script never
// clicks Submit and never invents a response.

(() => {
  "use strict";

  if (globalThis.__internshipPilotInjected) return;
  globalThis.__internshipPilotInjected = true;

  const BUTTON_ID = "internship-pilot-autofill";
  const PANEL_ID = "internship-pilot-panel";
  const DETAILS_ID = "internship-pilot-details";
  const SUBMIT_TEXT = /\b(submit|send application|apply now|finish|complete application)\b/i;
  const NEXT_TEXT = /\b(next|continue|save and continue)\b/i;

  const EXTENSION_VERSION = "1.2.0";
  const PROTOCOL_VERSION = 2;
  const BUNDLE_BRIDGE = {
    probe: "internship-agent:bridge-probe",
    probeAck: "internship-agent:bridge-available",
    offer: "internship-agent:bundle-offer",
    result: "internship-agent:bundle-result",
  };

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function visible(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest("[hidden], [aria-hidden='true']")) return false;
    if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
    // Honeypot & anti-bot checks
    if (element instanceof HTMLInputElement && element.type === "hidden") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    if (element.getClientRects().length === 0) return false;
    return true;
  }

  function sendMessageWithTimeout(message, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, error: `API request timed out after ${Math.round(timeoutMs / 1000)}s.` });
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: "The extension background worker did not respond." });
        });
      } catch (error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: String(error && error.message ? error.message : error) });
      }
    });
  }

  // Website -> extension handoff. postMessage crosses the page/isolated-world
  // boundary; only a message from this exact window and origin is accepted.
  window.addEventListener("message", (event) => {
    // Chrome wraps WindowProxy separately in the page and isolated worlds, so
    // object identity is not stable here. Exact origin + private channel +
    // request id are the enforceable boundary.
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data.requestId !== "string") return;
    if (data.channel === BUNDLE_BRIDGE.probe) {
      window.postMessage({ channel: BUNDLE_BRIDGE.probeAck, requestId: data.requestId }, location.origin);
      return;
    }
    if (data.channel !== BUNDLE_BRIDGE.offer) return;
    void sendMessageWithTimeout({ kind: "store-application-bundle", bundle: data.bundle }, 30000).then((result) => {
      window.postMessage({
        channel: BUNDLE_BRIDGE.result,
        requestId: data.requestId,
        result: result?.ok
          ? {
              ok: true,
              bundleId: result.bundleId,
              storedDocuments: result.storedDocuments,
              storedAt: result.storedAt,
            }
          : { ok: false, reason: result?.reason || result?.error || "The extension refused the application bundle." },
      }, location.origin);
    });
  });

  async function bundleForThisPage() {
    const result = await sendMessageWithTimeout({ kind: "application-bundle-for-page", pageUrl: location.href }, 5000);
    return result?.ok ? result.bundle : null;
  }

  async function transitionBundle(envelope, state, reason, metadata = {}) {
    await sendMessageWithTimeout({
      kind: "application-bundle-transition",
      bundleId: envelope.bundleId,
      state,
      reason,
      pageUrl: location.href,
      metadata,
    }, 5000);
  }

  function escapeSelector(value) {
    return globalThis.CSS?.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
  }

  function associatedLabel(element) {
    const ariaLabelledBy = clean(element.getAttribute("aria-labelledby"));
    if (ariaLabelledBy) {
      const text = ariaLabelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (clean(text)) return clean(text);
    }
    const ariaLabel = clean(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;

    const id = element.getAttribute("id") || "";
    if (id) {
      const direct = document.querySelector(`label[for="${escapeSelector(id)}"]`);
      if (direct) return clean(direct.textContent);
    }
    const wrapping = element.closest("label");
    if (wrapping) return clean(wrapping.textContent);

    const placeholder = clean(element.getAttribute("placeholder"));
    if (placeholder) return placeholder;

    const name = clean(element.getAttribute("name"));
    if (name) return name;

    return "";
  }

  function groupLabel(element) {
    const fieldset = element.closest("fieldset");
    const legend = fieldset?.querySelector(":scope > legend");
    if (legend) return clean(legend.textContent);
    const group = element.closest(
      "[role='group'], [role='radiogroup'], .application-question, .field, .form-field, .questions, .question",
    );
    if (!group) return "";
    const heading = group.querySelector(
      ":scope > label, :scope > legend, :scope > .label, :scope > .question-label, :scope > h1, :scope > h2, :scope > h3",
    );
    return clean(heading?.textContent);
  }

  function nearbyText(element) {
    const container = element.closest(
      "fieldset, [role='group'], [role='radiogroup'], .application-question, .field, .form-field, .question",
    ) || element.parentElement;
    return clean(container?.textContent).slice(0, 4000);
  }

  function optionLabel(element) {
    if (!(element instanceof HTMLInputElement) || !["radio", "checkbox"].includes(element.type)) return "";
    return associatedLabel(element)
      || clean(element.getAttribute("aria-label"))
      || clean(element.value);
  }

  function customOptions(element) {
    const owned = clean(element.getAttribute("aria-controls") || element.getAttribute("aria-owns"));
    const root = owned ? document.getElementById(owned) : null;
    const options = Array.from((root || document).querySelectorAll("[role='option']")).filter(visible);
    return options.map((option) => clean(option.textContent)).filter(Boolean).slice(0, 200);
  }

  function fieldElements() {
    const selector = [
      "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']):not([type='image'])",
      "textarea",
      "select",
      "[role='combobox']",
      "[contenteditable='true']",
    ].join(",");
    return Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .filter((element, index, values) => values.indexOf(element) === index)
      .slice(0, 500);
  }

  function visibleFields() {
    return fieldElements().map((element, index) => {
      element.setAttribute("data-ip-index", String(index));
      const tag = element.tagName.toLowerCase();
      const inputType = element instanceof HTMLInputElement ? element.type || "text" : tag;
      const label = associatedLabel(element);
      const group = groupLabel(element);
      const option = optionLabel(element);
      const ariaLabel = clean(element.getAttribute("aria-label"));
      const placeholder = clean(element.getAttribute("placeholder"));
      const role = clean(element.getAttribute("role"));
      const options = element instanceof HTMLSelectElement
        ? Array.from(element.options).map((item) => clean(item.textContent)).filter(Boolean)
        : role === "combobox" ? customOptions(element) : [];
      let currentValue = "";
      if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
        currentValue = String(element.checked);
      } else if ("value" in element) {
        currentValue = clean(element.value);
      } else {
        currentValue = clean(element.getAttribute("aria-valuetext") || element.textContent);
      }
      return {
        index,
        label: label || "",
        groupLabel: group || "",
        optionLabel: option || "",
        name: clean(element.getAttribute("name")) || "",
        id: clean(element.getAttribute("id")) || "",
        ariaLabel: ariaLabel || "",
        placeholder: placeholder || "",
        nearbyText: nearbyText(element) || "",
        role: role || "",
        type: element instanceof HTMLSelectElement ? "select" : inputType || "text",
        required: element.hasAttribute("required")
          || element.getAttribute("aria-required") === "true"
          || /\*/.test(group || label),
        options: (options || []).map(clean).filter(Boolean).slice(0, 200),
        currentValue: currentValue || "",
      };
    });
  }

  function unresolvedCaptcha() {
    const challenge = Array.from(document.querySelectorAll([
      "iframe[src*='recaptcha']",
      "iframe[src*='hcaptcha']",
      "iframe[title*='challenge' i]",
      "[class*='captcha' i]",
      "[id*='captcha' i]",
    ].join(","))).some(visible);
    if (!challenge) return false;
    const response = document.querySelector("textarea[name='g-recaptcha-response'], textarea[name='h-captcha-response']");
    return !response || !clean(response.value);
  }

  function pageBlockers() {
    const blockers = [];
    if (unresolvedCaptcha()) {
      blockers.push({ kind: "captcha", detail: "A CAPTCHA is present. Solve it yourself before retrying autofill." });
    }
    if (Array.from(document.querySelectorAll("input[type='password']")).some(visible)) {
      blockers.push({ kind: "login", detail: "This page asks for a password. Log in yourself before continuing." });
    }
    if (Array.from(document.querySelectorAll("input[autocomplete='one-time-code']")).some(visible)) {
      blockers.push({ kind: "mfa", detail: "This page asks for an MFA code. Complete authentication yourself." });
    }
    const pageText = clean(document.body?.innerText).slice(0, 20_000);
    if (/\b(coding|technical|skills|personality) assessment\b/i.test(pageText)
      && !/\bapplication form\b/i.test(pageText)) {
      blockers.push({ kind: "assessment", detail: "An assessment was detected. Internship Pilot does not take assessments." });
    }
    return blockers;
  }

  function setStage(stageText, tone = "info", details = null) {
    const panel = document.getElementById(PANEL_ID);
    const status = panel?.querySelector(".ip-status");
    if (status) status.textContent = stageText;
    if (panel) panel.dataset.tone = tone;

    if (details) {
      let detailsEl = document.getElementById(DETAILS_ID);
      if (!detailsEl && panel) {
        detailsEl = document.createElement("details");
        detailsEl.id = DETAILS_ID;
        detailsEl.className = "ip-details";
        const summary = document.createElement("summary");
        summary.textContent = "Show details";
        detailsEl.appendChild(summary);
        const content = document.createElement("pre");
        content.className = "ip-details-content";
        detailsEl.appendChild(content);
        panel.appendChild(detailsEl);
      }
      if (detailsEl) {
        const content = detailsEl.querySelector(".ip-details-content");
        if (content) content.textContent = JSON.stringify(details, null, 2);
      }
    }
  }

  function markCompletion(state, detail) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    button.dataset.ipState = state;
    button.dataset.ipDetail = detail ? JSON.stringify(detail) : "";
  }

  function outline(element, tone) {
    element.setAttribute("data-ip-result", tone);
  }

  function dispatchChanges(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setNativeValue(element, value) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    dispatchChanges(element);
    return true;
  }

  function normalized(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function matchingOption(options, value) {
    const wanted = normalized(value);
    return options.find((option) => {
      const candidate = normalized(option.textContent);
      return candidate && (candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate));
    });
  }

  async function selectValue(element, value) {
    if (element instanceof HTMLSelectElement) {
      const option = matchingOption(Array.from(element.options), value);
      if (!option) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (setter) setter.call(element, option.value);
      else element.value = option.value;
      dispatchChanges(element);
      return true;
    }
    element.focus();
    if (element instanceof HTMLInputElement) setNativeValue(element, value);
    else element.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const owned = clean(element.getAttribute("aria-controls") || element.getAttribute("aria-owns"));
    const root = owned ? document.getElementById(owned) : null;
    const options = Array.from((root || document).querySelectorAll("[role='option']")).filter(visible);
    const option = matchingOption(options, value);
    if (!option) return false;
    option.click();
    dispatchChanges(element);
    return true;
  }

  async function uploadDocument(element, documentId, runId) {
    if (!(element instanceof HTMLInputElement) || element.type !== "file") {
      return { ok: false, error: "The upload control is not a standard file input." };
    }
    const response = await sendMessageWithTimeout({ kind: "document", documentId, runId }, 15000);
    if (!response?.ok) return { ok: false, error: response?.error || "Document download failed." };
    const file = new File(
      [new Uint8Array(response.bytes)],
      response.filename,
      { type: response.contentType || "application/pdf" },
    );
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.files = transfer.files;
    dispatchChanges(element);
    return { ok: true, filename: response.filename };
  }

  function needUser(summary, meta, reason, element) {
    outline(element, "needs-user");
    summary.needsUser.push({
      label: meta.groupLabel || meta.label || meta.ariaLabel || meta.placeholder || meta.nearbyText || meta.name || "(Label unavailable)",
      reason,
      required: Boolean(meta.required),
      type: meta.type || "unknown",
      options: meta.options || [],
      ariaLabel: meta.ariaLabel || "",
      placeholder: meta.placeholder || "",
      nearbyText: meta.nearbyText || "",
    });
  }

  async function runBundledAutofill(envelope) {
    const engine = globalThis.InternshipPilotAutofillEngine;
    const bundle = envelope.bundle;
    const pageNumber = Math.max(1, Number(envelope.pageNumber) || 1);
    if (!engine || !bundle) throw new Error("The deterministic autofill engine or application bundle is unavailable.");
    if (pageNumber > 10) {
      const message = "The application exceeded the ten-page safety limit.";
      await transitionBundle(envelope, "BLOCKED", message, { pageNumber, errorCode: "PAGE_LIMIT_REACHED" });
      markCompletion("blocked", { message, blockers: [{ kind: "page_limit", detail: message }] });
      return;
    }

    await transitionBundle(envelope, "SCANNING", "Scanning visible DOM and accessibility controls.", { pageNumber });
    const blockers = engine.blockers();
    if (blockers.length) {
      await transitionBundle(envelope, "AWAITING_USER", blockers[0].code, { pageNumber, errorCode: blockers[0].kind });
      const detail = { message: blockers[0].detail, blockers, pageUrl: location.href, pageNumber };
      setStage(blockers[0].detail, "warn", detail);
      markCompletion("needs_user", detail);
      return;
    }

    const fields = engine.scanFields(pageNumber);
    if (!fields.length) {
      const detail = { message: "No visible application fields were found on this step.", pageUrl: location.href, pageNumber };
      await transitionBundle(envelope, "AWAITING_USER", detail.message, { pageNumber, requiredEmptyCount: 0 });
      setStage(detail.message, "warn", detail);
      markCompletion("no_form", detail);
      return;
    }

    await transitionBundle(envelope, "FILLING", `Filling ${fields.length} discovered controls from approved data.`, { pageNumber });
    const results = [];
    for (const field of fields) {
      const result = await engine.fillField(field, bundle);
      results.push({ index: field.index, label: field.accessibleName || field.questionText, required: field.required, type: field.type, ...result });
      field.element.setAttribute("data-ip-result", result.ok ? "filled" : result.reason === "RADIO_OPTION_NOT_MATCHED" ? "skipped" : "needs-user");
    }

    const questionCategories = [...new Set(fields.map((field) => engine.classifyField(field)))];
    const uploadedCount = results.filter((result) => result.ok && ["RESUME", "COVER_LETTER"].includes(result.concept)).length;
    await transitionBundle(envelope, "VALIDATING", "Verifying retained values, required fields, and employer validation.", { pageNumber, uploadedCount, questionCategories });
    const audit = engine.requiredAudit(fields, results);
    const requiredEmpty = audit.filter((entry) => entry.status !== "FILLED");
    const validationErrors = engine.validationErrors();
    const filledCount = results.filter((result) => result.ok && !result.unchanged).length;
    const failedCount = results.filter((result) => !result.ok && result.reason !== "RADIO_OPTION_NOT_MATCHED" && result.reason !== "NO_APPROVED_ANSWER").length;
    const unresolved = results.filter((result) => !result.ok && result.reason !== "RADIO_OPTION_NOT_MATCHED");
    const needsUserByIndex = new Map(requiredEmpty.map((entry) => {
      const field = fields.find((candidate) => candidate.index === entry.index);
      return [entry.index, {
        label: field?.questionText || field?.accessibleName || field?.label || "(Label unavailable)",
        reason: entry.reason || entry.status,
        required: true,
        type: field?.type || "unknown",
        options: field?.options || [],
        ariaLabel: field?.accessibleName || "",
        placeholder: field?.placeholder || "",
        nearbyText: field?.nearbyText || "",
        status: entry.status,
      }];
    }));
    for (const result of unresolved) {
      if (needsUserByIndex.has(result.index)) continue;
      const field = fields.find((candidate) => candidate.index === result.index);
      needsUserByIndex.set(result.index, {
        label: field?.questionText || field?.accessibleName || field?.label || "(Label unavailable)",
        reason: result.reason || "NEEDS_USER",
        required: false,
        type: field?.type || "unknown",
        options: field?.options || [],
        ariaLabel: field?.accessibleName || "",
        placeholder: field?.placeholder || "",
        nearbyText: field?.nearbyText || "",
        status: result.reason === "UNSUPPORTED_CONTROL" ? "UNSUPPORTED" : "NEEDS_USER",
      });
    }
    const needsUser = [...needsUserByIndex.values()];
    const diagnostics = {
      pageNumber,
      fieldCount: fields.length,
      filledCount,
      unchangedCount: results.filter((result) => result.unchanged).length,
      failedCount,
      needsUserCount: needsUser.length,
      requiredEmptyCount: requiredEmpty.length,
      validationErrorCount: validationErrors.length,
      fields: fields.map((field) => ({
        index: field.index,
        category: engine.classifyField(field),
        label: field.accessibleName || field.questionText,
        required: field.required,
        result: audit.find((entry) => entry.index === field.index)?.status || (results.find((entry) => entry.index === field.index)?.ok ? "FILLED" : "UNANSWERED_OPTIONAL"),
      })),
    };

    if (needsUser.length || validationErrors.length) {
      const message = requiredEmpty.length
        ? `${requiredEmpty.length} required field(s) need your review before navigation.`
        : needsUser.length
          ? `${needsUser.length} visible field(s) need your review before navigation.`
        : "The employer form reported validation errors that need review.";
      await transitionBundle(envelope, "AWAITING_USER", message, { pageNumber, filledCount, failedCount, requiredEmptyCount: requiredEmpty.length, uploadedCount, questionCategories, unresolvedCategories: unresolved.map((entry) => entry.concept) });
      setStage(message, "warn", diagnostics);
      markCompletion("needs_user", { message, needsUser, blockers: [], ...diagnostics });
      return;
    }

    const final = engine.finalAction();
    if (final) {
      const message = "Application is ready for your review. Final submission was not clicked.";
      await transitionBundle(envelope, "REVIEW_READY", message, { pageNumber, filledCount, failedCount, requiredEmptyCount: 0, uploadedCount, questionCategories, unresolvedCategories: [] });
      setStage(message, "ok", diagnostics);
      markCompletion("filled", { message, needsUser: [], blockers: [], ...diagnostics });
      return;
    }

    const next = engine.nextAction();
    if (next) {
      const message = `Page ${pageNumber} verified; continuing to the next application step.`;
      await transitionBundle(envelope, "NAVIGATING", message, { pageNumber: pageNumber + 1, filledCount, failedCount, requiredEmptyCount: 0, uploadedCount, questionCategories, unresolvedCategories: [] });
      setStage(message, "info", diagnostics);
      markCompletion("navigating", { message, ...diagnostics });
      next.click();
      // SPA applications keep the same content-script instance. A full page
      // navigation gets a fresh instance and recovers the stored bundle.
      setTimeout(async () => {
        const current = await bundleForThisPage();
        if (current) {
          const button = document.getElementById(BUTTON_ID);
          if (button) button.dataset.ipState = "ready";
          void runAutofill();
        }
      }, 700);
      return;
    }

    const message = "Visible fields are filled. Review this page; no safe Continue action was found.";
    await transitionBundle(envelope, "REVIEW_READY", message, { pageNumber, filledCount, failedCount, requiredEmptyCount: 0, uploadedCount, questionCategories, unresolvedCategories: [] });
    setStage(message, "ok", diagnostics);
    markCompletion("filled", { message, needsUser: [], blockers: [], ...diagnostics });
  }

  async function runAutofill() {
    const button = document.getElementById(BUTTON_ID);
    if (!button || button.dataset.ipState === "running") return;
    button.disabled = true;
    button.dataset.ipState = "running";
    button.dataset.ipDetail = "";

    setStage("Extension initialized", "info");

    const pendingBundle = await bundleForThisPage();
    if (pendingBundle) {
      try {
        await runBundledAutofill(pendingBundle);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        await transitionBundle(pendingBundle, "FAILED", message, { errorCode: "AUTOFILL_ENGINE_FAILURE" });
        setStage(`Autofill failed: ${message}`, "error", { errorCode: "AUTOFILL_ENGINE_FAILURE" });
        markCompletion("error", { message });
      } finally {
        button.disabled = false;
      }
      return;
    }

    let fields = [];
    let blockers = [];
    try {
      setStage("Reading visible fields", "info");
      fields = visibleFields();
      blockers = pageBlockers();
    } catch (err) {
      const errMsg = String(err && err.message ? err.message : err);
      setStage("Failed at DOM scan stage", "error", { stage: "DOM_SCAN", errorCode: "DOM_SCAN_FAILURE", message: errMsg });
      markCompletion("error", { message: `DOM scan failed: ${errMsg}` });
      button.disabled = false;
      return;
    }

    if (fields.length === 0) {
      setStage("No visible application fields were found.", "warn", { stage: "READING_FIELDS", fieldCount: 0 });
      markCompletion("no_form", { message: "No visible application fields were found." });
      button.disabled = false;
      return;
    }

    setStage(`Found ${fields.length} visible fields`, "info", { stage: "FIELDS_FOUND", fieldCount: fields.length });

    const runId = clean(document.documentElement.getAttribute("data-internship-pilot-run-id")) || null;
    setStage("Sending form description", "info");

    const plan = await sendMessageWithTimeout({
      kind: "fill-plan",
      payload: {
        runId,
        pageUrl: location.href,
        pageTitle: document.title,
        fields,
        blockers,
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: 1,
      },
    }, 15000);

    if (!plan?.ok || !plan.body) {
      const message = plan?.error || plan?.body?.error || "Internship Pilot could not prepare a safe fill plan.";
      const errorCode = plan?.status === 0 ? "SERVER_UNAVAILABLE" : plan?.body?.errorCode || "FORM_DESCRIPTION_INVALID";
      setStage(`Failed at API stage: ${message}`, "error", {
        stage: "API_FILL_PLAN",
        errorCode,
        message,
        fieldCount: fields.length,
        extensionVersion: EXTENSION_VERSION,
        serverVersion: PROTOCOL_VERSION,
        retrySafe: true,
      });
      markCompletion(plan?.status === 0 ? "backend_unreachable" : "error", { message, status: plan?.status ?? null });
      button.disabled = false;
      return;
    }

    const body = plan.body;
    setStage("Loading candidate profile & building fill plan", "info");

    const summary = { filled: 0, uploaded: 0, skipped: 0, needsUser: [] };
    const answers = {};

    const instructions = body.fields || [];
    for (let i = 0; i < instructions.length; i += 1) {
      const instruction = instructions[i];
      const element = document.querySelector(`[data-ip-index="${instruction.index}"]`);
      const meta = fields[instruction.index];
      if (!element || !meta) continue;

      const displayLabel = meta.groupLabel || meta.label || meta.ariaLabel || meta.placeholder || meta.name || `Field ${instruction.index}`;
      setStage(`Filling field ${i + 1} of ${instructions.length}: ${displayLabel}`, "info");

      if (instruction.action === "skip") {
        summary.skipped += 1;
        continue;
      }
      if (instruction.action === "needs_user" || instruction.action === "leave_for_user") {
        needUser(summary, meta, instruction.reason || "This field requires your review.", element);
        continue;
      }
      if (instruction.action === "upload_resume" || instruction.action === "upload_cover_letter") {
        setStage(`Uploading ${instruction.action === "upload_resume" ? "resume" : "cover letter"}…`, "info");
        const uploaded = await uploadDocument(element, instruction.documentId, body.runId);
        if (!uploaded.ok) {
          needUser(summary, meta, uploaded.error || "The document could not be uploaded.", element);
          continue;
        }
        summary.uploaded += 1;
        answers[displayLabel] = uploaded.filename;
        outline(element, "filled");
        continue;
      }
      if (instruction.action === "check") {
        if (!(element instanceof HTMLInputElement) || !["radio", "checkbox"].includes(element.type)) {
          needUser(summary, meta, "This option could not be selected deterministically.", element);
          continue;
        }
        if (!element.checked) element.click();
        if (!element.checked) {
          needUser(summary, meta, "This option did not remain selected.", element);
          continue;
        }
        summary.filled += 1;
        answers[displayLabel] = instruction.answer || "Selected";
        outline(element, "filled");
        continue;
      }
      if (instruction.action === "select") {
        if (!(await selectValue(element, instruction.value))) {
          needUser(summary, meta, `No visible dropdown option matched "${instruction.value}".`, element);
          continue;
        }
        summary.filled += 1;
        answers[displayLabel] = instruction.value;
        outline(element, "filled");
        continue;
      }
      if (instruction.action === "fill") {
        if (!setNativeValue(element, instruction.value)) {
          needUser(summary, meta, "This custom field could not be filled deterministically.", element);
          continue;
        }
        summary.filled += 1;
        answers[displayLabel] = instruction.value;
        outline(element, "filled");
      }
    }

    setStage("Checking required fields & final review state", "info");

    const state = blockers.length > 0
      ? "blocked"
      : summary.needsUser.length > 0 ? "needs_user" : "filled";
    const message = state === "filled"
      ? `Completed. Filled ${summary.filled} field(s) and uploaded ${summary.uploaded} document(s). Review everything; Submit remains manual.`
      : `Needs review. Filled what was safe. ${summary.needsUser.length + blockers.length} item(s) need your review. Submit remains manual.`;

    setStage(message, state === "filled" ? "ok" : "warn", {
      stage: state === "filled" ? "COMPLETED" : "NEEDS_REVIEW",
      filledCount: summary.filled,
      uploadedCount: summary.uploaded,
      needsReviewCount: summary.needsUser.length + blockers.length,
      retrySafe: true,
    });

    const report = {
      runId: body.runId,
      pageUrl: location.href,
      jobId: body.job.id,
      state,
      blockers,
      filledCount: summary.filled,
      uploadedCount: summary.uploaded,
      answers,
      needsUser: summary.needsUser,
    };

    await sendMessageWithTimeout({ kind: "report", payload: report }, 10000);

    markCompletion(state, {
      filled: summary.filled,
      uploaded: summary.uploaded,
      needsUser: summary.needsUser.slice(0, 20),
      blockers,
      runId: body.runId,
      pageUrl: location.href,
    });
    button.disabled = false;
  }

  function append(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function looksLikeApplication(fields) {
    if (fields.length < 2) return false;
    const url = location.href.toLowerCase();
    if (/greenhouse|lever\.co|ashbyhq|workday|smartrecruiters|icims|taleo/.test(url)) return true;
    const hasUpload = fields.some((field) => field.type === "file");
    const hasIdentity = fields.some((field) => /name|email|phone|resume|\bcv\b/i.test([
      field.label,
      field.ariaLabel,
      field.placeholder,
      field.name,
    ].join(" ")));
    const hasApplicationAction = Array.from(document.querySelectorAll("button, input[type='submit']"))
      .filter(visible)
      .some((element) => SUBMIT_TEXT.test(clean(element.textContent || element.getAttribute("value"))));
    return hasIdentity && (hasUpload || hasApplicationAction);
  }

  function inject(force = false) {
    if (document.getElementById(BUTTON_ID)) return;
    const fields = visibleFields();
    if (!force && !looksLikeApplication(fields)) return;

    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.dataset.tone = "info";
    panel.setAttribute("aria-label", "Internship Pilot autofill");

    const header = append(panel, "div", "ip-header", "");
    append(header, "span", "ip-logo", "IP");
    append(header, "span", "ip-title", "Internship Pilot");
    append(header, "span", "ip-mode", "FILL TO SUBMIT");

    const button = append(panel, "button", "ip-button", "Autofill with Internship Pilot");
    button.id = BUTTON_ID;
    button.type = "button";
    button.setAttribute("data-internship-pilot-action", "autofill");
    button.dataset.ipState = "ready";
    button.addEventListener("click", () => void runAutofill());

    append(panel, "p", "ip-status", "Waiting for page");
    document.documentElement.appendChild(panel);

    const autoStart = document.documentElement.hasAttribute("data-internship-pilot-run-id")
      || document.documentElement.hasAttribute("data-internship-pilot-auto-start");
    if (autoStart) {
      setTimeout(() => void runAutofill(), 300);
    }
  }

  // Defense in depth: block any synthetic click on a submit-like control.
  document.addEventListener("click", (event) => {
    if (event.isTrusted || !(event.target instanceof Element)) return;
    const control = event.target.closest("button, input[type='submit'], [role='button']");
    const text = clean(control?.textContent || control?.getAttribute("value") || control?.getAttribute("aria-label"));
    if (control && SUBMIT_TEXT.test(text) && !NEXT_TEXT.test(text)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  inject();
  void bundleForThisPage().then((bundle) => {
    if (!bundle) return;
    inject(true);
    setTimeout(() => void runAutofill(), 200);
  });
  const observer = new MutationObserver(() => inject());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
