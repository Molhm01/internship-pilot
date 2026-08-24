// Deterministic DOM/accessibility autofill engine. No network, vision, or identity guessing.
(() => {
  "use strict";

  const FINAL_ACTION = /\b(submit(?: application)?|send application|finish(?: application)?|complete application|apply now)\b/i;
  const NEXT_ACTION = /\b(next|continue|save and continue|review)\b/i;
  const LEGAL = /\b(attest|certif(?:y|ication)|electronic signature|signature|arbitration|background check|consent|terms of|i agree|acknowledge under|export control)\b/i;
  const EEO = /\b(gender|sex|race|ethnicity|veteran|disabilit|self.identif|demographic)\b/i;
  const DECLINE = new Set([
    "decline to answer", "prefer not to say", "i do not wish to answer",
    "decline to self identify", "choose not to disclose", "do not wish to disclose",
    "i don t wish to answer", "prefer not to disclose",
  ]);
  const STATE_NAMES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
    CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
    IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
    ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
    MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
    NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
    PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
    TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
    WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
  };
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const clean = (value) => String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const normalized = (value) => clean(value).toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9+#]+/g, " ").trim();
  const visible = (element) => {
    if (!(element instanceof Element) || element.closest("[hidden], [aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const escapeSelector = (value) => globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");

  function discoverableFileInput(element) {
    if (!(element instanceof HTMLInputElement) || element.type !== "file") return false;
    const label = element.id ? document.querySelector(`label[for="${escapeSelector(element.id)}"]`) : element.closest("label");
    const dropZone = element.closest("[class*='drop' i],[data-automation-id*='upload' i],[data-testid*='upload' i]");
    return Boolean((label && visible(label)) || (dropZone && visible(dropZone)));
  }

  function referencedText(value) {
    return clean(String(value || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
  }

  function labelParts(element) {
    const labelled = referencedText(element.getAttribute("aria-labelledby"));
    const aria = clean(element.getAttribute("aria-label"));
    const id = element.id || "";
    const explicit = id ? clean(document.querySelector(`label[for="${escapeSelector(id)}"]`)?.textContent) : "";
    const wrapped = clean(element.closest("label")?.textContent);
    const fieldset = element.closest("fieldset");
    const legend = clean(fieldset?.querySelector(":scope > legend")?.textContent);
    const container = element.closest("[role='group'],[role='radiogroup'],.application-question,.question,.field,.form-field,[data-automation-id*='formField']");
    const question = clean(container?.querySelector(":scope > label,:scope > legend,:scope > [role='heading'],:scope > .label,:scope > .question-label")?.textContent);
    const placeholder = clean(element.getAttribute("placeholder"));
    const name = clean(element.getAttribute("name") || element.id);
    const nearbyRoot = container || element.closest("label") || (element.parentElement?.matches("form,body,html") ? null : element.parentElement);
    return {
      accessibleName: labelled || aria || explicit || wrapped || legend || question || placeholder || name,
      label: explicit || wrapped || aria || labelled || placeholder || name,
      questionText: legend || question || explicit || labelled || aria || wrapped,
      section: clean(element.closest("section,fieldset,[role='group']")?.querySelector("h1,h2,h3,h4,legend")?.textContent),
      placeholder,
      name,
      nearbyText: clean(nearbyRoot?.textContent).slice(0, 2_000),
    };
  }

  function controlType(element) {
    const role = normalized(element.getAttribute("role"));
    if (role === "combobox") return element.matches("input") ? "autocomplete" : "combobox";
    if (role === "listbox") return "listbox";
    if (element instanceof HTMLSelectElement) return "select";
    if (element instanceof HTMLTextAreaElement || element.getAttribute("contenteditable") === "true") return "textarea";
    if (element instanceof HTMLInputElement) {
      if (["radio", "checkbox", "file", "email", "tel", "url", "number", "date", "month"].includes(element.type)) return element.type;
      return "text";
    }
    return "custom_select";
  }

  function optionsFor(element) {
    if (element instanceof HTMLSelectElement) return Array.from(element.options).map((option) => clean(option.textContent)).filter(Boolean);
    const owned = clean(element.getAttribute("aria-controls") || element.getAttribute("aria-owns"));
    const root = owned ? document.getElementById(owned) : null;
    return Array.from((root || document).querySelectorAll("[role='option'],[role='menuitemradio']"))
      .filter(visible).map((option) => clean(option.textContent || option.getAttribute("aria-label"))).filter(Boolean).slice(0, 300);
  }

  function currentValue(element) {
    if (element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type)) return element.checked ? clean(element.value || "true") : "";
    if (element instanceof HTMLInputElement && element.type === "file") return element.files?.[0]?.name || "";
    if ("value" in element) return clean(element.value);
    return clean(element.getAttribute("aria-valuetext") || element.textContent);
  }

  function scanFields(pageIndex = 1) {
    const selector = [
      "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']):not([type='image']):not([type='password'])",
      "textarea", "select", "[role='combobox']", "[role='listbox']", "[contenteditable='true']",
      "button[aria-haspopup='listbox']",
    ].join(",");
    return Array.from(document.querySelectorAll(selector)).filter((element) => visible(element) || discoverableFileInput(element)).filter((item, index, all) => all.indexOf(item) === index).slice(0, 500).map((element, index) => {
      element.setAttribute("data-ip-index", String(index));
      const labels = labelParts(element);
      const type = controlType(element);
      const optionLabel = element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type)
        ? clean(element.closest("label")?.textContent || element.getAttribute("aria-label") || element.value)
        : "";
      const requiredText = `${labels.questionText} ${labels.label}`;
      return {
        id: element.id || `ip-field-${pageIndex}-${index}`,
        index, element, type, ...labels,
        required: element.hasAttribute("required") || element.getAttribute("aria-required") === "true" || /(?:^|\s)\*(?:\s|$)/.test(requiredText) || /\brequired\b/i.test(labels.nearbyText),
        options: optionsFor(element),
        autocomplete: clean(element.getAttribute("autocomplete")),
        currentValue: currentValue(element),
        pageIndex,
        optionLabel,
      };
    });
  }

  function serializeField(field) {
    const descriptor = { ...field };
    delete descriptor.element;
    return descriptor;
  }

  function classifyField(field) {
    const text = normalized([field.accessibleName, field.questionText, field.label, field.name, field.placeholder, field.section].join(" "));
    const exact = (pattern) => pattern.test(text);
    if (field.type === "file") return /cover letter|motivation letter/.test(text) ? "COVER_LETTER" : "RESUME";
    if (/preferred|chosen/.test(text) && /name/.test(text)) return "PREFERRED_NAME";
    if (/first|given/.test(text) && /name/.test(text)) return "FIRST_NAME";
    if (/last|family|surname/.test(text) && /name/.test(text)) return "LAST_NAME";
    if (/full name|legal name|candidate name|your name/.test(text)) return "FULL_NAME";
    if (exact(/\bemail\b/)) return "EMAIL";
    if (/country code|calling code|dial code|phone prefix/.test(text)) return "COUNTRY_CODE";
    if (/\b(phone|telephone|mobile)\b/.test(text)) return "PHONE";
    if (/address line 2|address 2|apt|suite/.test(text)) return "ADDRESS_2";
    if (/street|address line 1|address 1|mailing address/.test(text)) return "ADDRESS";
    if (/postal|zip/.test(text)) return "ZIP";
    if (/\bcity\b|municipality/.test(text)) return "CITY";
    if (/\b(state|province|region)\b/.test(text)) return "STATE";
    if (/\bcountry\b/.test(text)) return "COUNTRY";
    if (/linkedin/.test(text)) return "LINKEDIN";
    if (/github/.test(text)) return "GITHUB";
    if (/portfolio/.test(text)) return "PORTFOLIO";
    if (/school|university|college|institution/.test(text)) return "SCHOOL";
    if (/major|field of study|discipline/.test(text)) return "MAJOR";
    if (/degree|education level/.test(text)) return "DEGREE";
    if (/graduat/.test(text) && /month/.test(text)) return "GRAD_MONTH";
    if (/graduat/.test(text) && /year/.test(text)) return "GRAD_YEAR";
    if (/graduat/.test(text) && /date/.test(text)) return "GRAD_DATE";
    if (/\bgpa\b|grade point/.test(text)) return "GPA";
    if (/authorized|authorised|eligible/.test(text) && /work|employment/.test(text)) return "WORK_AUTHORIZED";
    if (/sponsor|visa support/.test(text)) return "SPONSORSHIP_REQUIRED";
    if (/18 years|age of 18|minimum age/.test(text)) return "AGE_18";
    if (/relocat/.test(text)) return "RELOCATION";
    if (/start date|available to start|earliest start/.test(text)) return "START_DATE";
    if (/gender|\bsex\b/.test(text)) return "GENDER";
    if (/race|ethnic/.test(text)) return "RACE";
    if (/veteran/.test(text)) return "VETERAN";
    if (/disabilit/.test(text)) return "DISABILITY";
    if (/previously|before|prior|ever/.test(text) && /work|employ/.test(text)) return "PREVIOUS_EMPLOYMENT";
    if (/previously|before|prior|ever/.test(text) && /appl/.test(text)) return "PREVIOUS_APPLICATION";
    if (/relative|family member/.test(text) && /work|employ/.test(text)) return "EMPLOYEE_RELATIONSHIP";
    if (/referr|how did you hear/.test(text)) return "REFERRAL";
    if (field.type === "textarea" && /why|describe|experience|good fit|interest|additional information|tell us/.test(text)) return "CUSTOM_FREE_RESPONSE";
    return "UNKNOWN";
  }

  function dateParts(value) {
    const match = clean(value).match(/^(\d{4})(?:-(\d{1,2}))?/);
    return match ? { year: match[1], month: match[2] ? String(Number(match[2])) : null } : { year: null, month: null };
  }

  function sensitiveAnswer(profile, concept) {
    const category = { GENDER: "gender", RACE: "race", VETERAN: "veteran_status", DISABILITY: "disability" }[concept];
    if (!category) return null;
    const policy = (profile.sensitivePolicies || []).find((entry) => entry.category === category);
    if (!policy) return null;
    if (policy.policy === "decline_to_answer") return "Decline to answer";
    return policy.policy === "approved_auto_fill" && clean(policy.value) ? clean(policy.value) : null;
  }

  function approvedAnswer(bundle, field) {
    const question = normalized(field.questionText || field.accessibleName || field.label);
    for (const answer of bundle.approvedAnswers || []) {
      if (answer?.approved === false || answer?.autoFillAllowed === false) continue;
      const candidates = [answer.normalizedQuestion, answer.canonicalQuestion, ...(answer.aliases || [])].map(normalized);
      if (candidates.includes(question) && clean(answer.answer)) return clean(answer.answer);
    }
    return null;
  }

  function groundedFreeResponse(bundle, field) {
    const question = normalized(field.questionText || field.accessibleName || field.label);
    const profile = bundle.profile || {};
    const projects = profile.projects || [];
    const experience = profile.experience || [];
    const skills = [...(profile.skills?.technical || []), ...(profile.skills?.programmingLanguages || [])];
    const never = (bundle.answerContext?.neverClaimFacts || []).map(normalized);
    const safeSkills = skills.filter((skill) => !never.some((claim) => normalized(skill).includes(claim) || claim.includes(normalized(skill))));
    const project = projects.find((entry) => clean(entry.description || entry.accomplishments?.[0])) || projects[0];
    const role = clean(bundle.jobTitle);
    const company = clean(bundle.company);
    if (/why.*(company|here)|interest.*company/.test(question)) {
      const evidence = project ? `my approved project work on ${clean(project.name)}` : safeSkills.length ? `my documented experience with ${safeSkills.slice(0, 3).join(", ")}` : null;
      return evidence ? `I am interested in the ${role} role at ${company} because its responsibilities connect directly with ${evidence}. I would value the chance to contribute that experience while learning from the team.` : null;
    }
    if (/why.*role|interest.*role|good fit|what makes you/.test(question)) {
      const evidence = project ? `${clean(project.name)}${clean(project.description) ? `, where I ${clean(project.description)}` : ""}` : experience[0] ? `${clean(experience[0].title)} at ${clean(experience[0].employer)}` : null;
      return evidence ? `My approved background includes ${evidence}. That experience and my documented skills in ${safeSkills.slice(0, 4).join(", ") || "the areas listed in my résumé"} are relevant to the ${role} responsibilities.` : null;
    }
    if (/describe.*project|relevant project/.test(question) && project) {
      const details = [project.description, ...(project.accomplishments || [])].map(clean).filter(Boolean).slice(0, 2).join(" ");
      return `${clean(project.name)} is a relevant project from my approved profile. ${details}`.trim();
    }
    if (/experience with/.test(question)) {
      const requested = safeSkills.find((skill) => question.includes(normalized(skill)));
      if (!requested) return null;
      const evidenceProject = projects.find((entry) => [...(entry.technologies || []), ...(entry.accomplishments || [])].some((value) => normalized(value).includes(normalized(requested))));
      return evidenceProject
        ? `I used ${requested} in ${clean(evidenceProject.name)}. ${clean(evidenceProject.description || evidenceProject.accomplishments?.[0])}`.trim()
        : `My approved profile lists ${requested} as a documented skill. I would be glad to discuss the specific context and depth during an interview.`;
    }
    return null;
  }

  function answerFor(bundle, field) {
    const concept = classifyField(field);
    const profile = bundle.profile || {};
    const personal = profile.personal || {};
    const address = personal.address || {};
    const education = profile.education?.[0] || {};
    const graduation = dateParts(education.graduationDate);
    const relationship = bundle.companyRelationship || {};
    const values = {
      FIRST_NAME: personal.legalFirstName,
      LAST_NAME: personal.legalLastName,
      FULL_NAME: personal.legalFirstName && personal.legalLastName ? `${personal.legalFirstName} ${personal.legalLastName}` : null,
      PREFERRED_NAME: personal.preferredName,
      EMAIL: personal.email,
      PHONE: personal.phone,
      COUNTRY_CODE: personal.phoneCountryCode,
      ADDRESS: address.line1,
      ADDRESS_2: address.line2,
      CITY: address.city,
      STATE: address.state,
      ZIP: address.postalCode,
      COUNTRY: address.country,
      LINKEDIN: personal.linkedin,
      GITHUB: personal.github,
      PORTFOLIO: personal.portfolio || personal.personalWebsite,
      SCHOOL: education.institution,
      DEGREE: education.degree || education.degreeLevel,
      MAJOR: education.major,
      GRAD_MONTH: graduation.month,
      GRAD_YEAR: graduation.year,
      GRAD_DATE: education.graduationDate,
      GPA: education.gpa,
      WORK_AUTHORIZED: profile.eligibility?.workAuthorization,
      SPONSORSHIP_REQUIRED: profile.eligibility?.requiresSponsorshipNow ?? profile.eligibility?.requiresFutureSponsorship,
      AGE_18: profile.eligibility?.meetsMinimumAge,
      RELOCATION: profile.eligibility?.willingToRelocate,
      START_DATE: profile.eligibility?.earliestStartDate,
      PREVIOUS_EMPLOYMENT: relationship.previouslyEmployed,
      PREVIOUS_APPLICATION: relationship.previouslyApplied,
      EMPLOYEE_RELATIONSHIP: relationship.familyMemberEmployed,
      REFERRAL: relationship.referralName || relationship.hasReferral,
    };
    if (["GENDER", "RACE", "VETERAN", "DISABILITY"].includes(concept)) {
      const value = sensitiveAnswer(profile, concept);
      return { value, source: value ? "saved_sensitive_policy" : "none", concept };
    }
    const companyScoped = ["PREVIOUS_EMPLOYMENT", "PREVIOUS_APPLICATION", "EMPLOYEE_RELATIONSHIP", "REFERRAL"].includes(concept);
    if (!companyScoped) {
      const saved = approvedAnswer(bundle, field);
      if (saved) return { value: saved, source: "approved_answer", concept };
    }
    if (concept === "CUSTOM_FREE_RESPONSE") {
      const value = groundedFreeResponse(bundle, field);
      return { value, source: value ? "approved_context" : "none", concept };
    }
    const raw = values[concept];
    const value = typeof raw === "boolean" ? (raw ? "Yes" : "No") : raw === null || raw === undefined ? null : String(raw);
    return { value: clean(value) || null, source: value ? "profile" : "none", concept };
  }

  function equivalentScore(option, answer) {
    const left = normalized(option);
    const right = normalized(answer);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (DECLINE.has(left) && DECLINE.has(right)) return 1;
    if (["yes", "no"].includes(left) || ["yes", "no"].includes(right)) return left === right ? 1 : 0;
    const country = new Set(["us", "usa", "united states", "united states of america"]);
    if (country.has(left) && country.has(right)) return 1;
    for (const [abbr, name] of Object.entries(STATE_NAMES)) {
      const variants = new Set([normalized(abbr), normalized(name)]);
      if (variants.has(left) && variants.has(right)) return 1;
    }
    const monthIndex = MONTHS.findIndex((month) => [normalized(month), String(MONTHS.indexOf(month) + 1), String(MONTHS.indexOf(month) + 1).padStart(2, "0"), normalized(month.slice(0, 3))].includes(left));
    if (monthIndex >= 0 && [normalized(MONTHS[monthIndex]), String(monthIndex + 1), String(monthIndex + 1).padStart(2, "0"), normalized(MONTHS[monthIndex].slice(0, 3))].includes(right)) return 1;
    if ((left.includes(right) || right.includes(left)) && Math.min(left.length, right.length) >= 4) return 0.9;
    const a = new Set(left.split(" "));
    const b = new Set(right.split(" "));
    const overlap = [...a].filter((token) => b.has(token)).length;
    return overlap / Math.max(a.size, b.size);
  }

  function bestOption(options, answer, threshold = 0.82) {
    const ranked = options.map((option) => ({ option, score: equivalentScore(clean(option.textContent || option.label || option), answer) }))
      .sort((left, right) => right.score - left.score);
    return ranked[0]?.score >= threshold ? ranked[0] : null;
  }

  function dispatchEvents(element, value) {
    element.focus();
    try { element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: String(value) })); } catch { /* old pages */ }
    try { element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) })); } catch { element.dispatchEvent(new Event("input", { bubbles: true })); }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  }

  function setNativeValue(element, value) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
      if (element.value !== String(value)) element.value = String(value);
      dispatchEvents(element, value);
      return true;
    }
    if (element.getAttribute("contenteditable") === "true") {
      element.focus();
      element.textContent = String(value);
      dispatchEvents(element, value);
      return true;
    }
    return false;
  }

  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function retainedValueMatches(concept, actual, requested) {
    if (["PHONE", "COUNTRY_CODE", "ZIP"].includes(concept)) {
      const left = clean(actual).replace(/\D/g, "");
      const right = clean(requested).replace(/\D/g, "");
      return left.length > 0 && left === right;
    }
    if (["LINKEDIN", "GITHUB", "PORTFOLIO"].includes(concept)) {
      return normalized(actual).replace(/\/$/, "") === normalized(requested).replace(/\/$/, "");
    }
    return normalized(actual) === normalized(requested);
  }

  async function selectValue(field, value) {
    const element = field.element;
    if (element instanceof HTMLSelectElement) {
      const match = bestOption(Array.from(element.options), value);
      if (!match) return { ok: false, reason: "NO_CONFIDENT_OPTION" };
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(element, match.option.value);
      dispatchEvents(element, match.option.value);
      await pause(80);
      return element.value === match.option.value ? { ok: true, value: clean(match.option.textContent) } : { ok: false, reason: "SELECTION_REVERTED" };
    }
    element.focus();
    element.click();
    if (element instanceof HTMLInputElement) setNativeValue(element, value);
    await pause(120);
    const owned = clean(element.getAttribute("aria-controls") || element.getAttribute("aria-owns"));
    const root = owned ? document.getElementById(owned) : null;
    const options = Array.from((root || document).querySelectorAll("[role='option'],[role='menuitemradio']")).filter(visible);
    const match = bestOption(options, value);
    if (!match) return { ok: false, reason: "NO_CONFIDENT_OPTION" };
    match.option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    match.option.click();
    await pause(100);
    const selected = match.option.getAttribute("aria-selected") === "true"
      || normalized(currentValue(element)) === normalized(clean(match.option.textContent))
      || normalized(clean(element.textContent)).includes(normalized(clean(match.option.textContent)));
    return selected ? { ok: true, value: clean(match.option.textContent) } : { ok: false, reason: "SELECTION_NOT_VERIFIED" };
  }

  function base64Bytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function upload(field, bundle, concept) {
    const element = field.element;
    if (!(element instanceof HTMLInputElement) || element.type !== "file") return { ok: false, reason: "UNSUPPORTED_UPLOAD_CONTROL" };
    const kind = concept === "COVER_LETTER" ? "cover_letter" : "resume";
    const document = bundle.documents.find((item) => item.kind === kind);
    if (!document) return { ok: false, reason: "CURRENT_JOB_DOCUMENT_MISSING" };
    if (document.websiteJobId !== bundle.websiteJobId || document.documentFingerprint !== bundle.documentFingerprint) return { ok: false, reason: "WRONG_JOB_DOCUMENT" };
    if (document.qaStatus !== "pass" || document.identityVerified !== true) return { ok: false, reason: "DOCUMENT_QA_REJECTED" };
    const bytes = base64Bytes(document.contentBase64);
    if (bytes.byteLength !== document.byteLength) return { ok: false, reason: "DOCUMENT_BYTE_LENGTH_MISMATCH" };
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], document.filename, { type: "application/pdf", lastModified: Date.parse(document.generatedAt) || Date.now() }));
    element.files = transfer.files;
    dispatchEvents(element, document.filename);
    await pause(80);
    return element.files?.length === 1 && element.files[0].name === document.filename
      ? { ok: true, value: document.filename }
      : { ok: false, reason: "UPLOAD_NOT_VERIFIED" };
  }

  async function fillField(field, bundle) {
    const concept = classifyField(field);
    if (concept === "RESUME" || concept === "COVER_LETTER") return { concept, ...(await upload(field, bundle, concept)) };
    const legalText = `${field.questionText} ${field.accessibleName} ${field.nearbyText}`;
    if (LEGAL.test(legalText)) return { ok: false, concept, reason: "LEGAL_ATTESTATION_REQUIRES_USER" };
    const answer = answerFor(bundle, field);
    if (!answer.value) return { ok: false, concept, reason: EEO.test(legalText) ? "SENSITIVE_ANSWER_NOT_SAVED" : "NO_APPROVED_ANSWER" };
    if (field.type === "select" || ["combobox", "autocomplete", "listbox", "custom_select"].includes(field.type)) {
      return { concept, answer: answer.value, ...(await selectValue(field, answer.value)) };
    }
    if (field.type === "radio") {
      if (equivalentScore(field.optionLabel, answer.value) < 0.82) return { ok: false, concept, reason: "RADIO_OPTION_NOT_MATCHED" };
      if (!field.element.checked) field.element.click();
      await pause(60);
      return field.element.checked ? { ok: true, concept, value: field.optionLabel } : { ok: false, concept, reason: "RADIO_NOT_VERIFIED" };
    }
    if (field.type === "checkbox") {
      if (!/^(yes|true|checked|i agree)$/i.test(answer.value)) return { ok: true, concept, value: "unchecked", unchanged: true };
      if (!field.element.checked) field.element.click();
      await pause(60);
      return field.element.checked ? { ok: true, concept, value: "checked" } : { ok: false, concept, reason: "CHECKBOX_NOT_VERIFIED" };
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!setNativeValue(field.element, answer.value)) return { ok: false, concept, reason: "UNSUPPORTED_CONTROL" };
      await pause(attempt === 1 ? 80 : 160);
      if (retainedValueMatches(concept, currentValue(field.element), answer.value)) return { ok: true, concept, value: currentValue(field.element), attempt };
    }
    return { ok: false, concept, reason: "VALUE_REVERTED" };
  }

  function empty(field) {
    const element = field.element;
    if (element instanceof HTMLInputElement && element.type === "radio") {
      return !Array.from(document.querySelectorAll(`input[type='radio'][name="${escapeSelector(element.name)}"]`)).some((item) => item.checked);
    }
    if (element instanceof HTMLInputElement && element.type === "checkbox") return !element.checked;
    if (element instanceof HTMLInputElement && element.type === "file") return !element.files?.length;
    return !clean(currentValue(element));
  }

  function requiredAudit(fields, results = []) {
    return fields.filter((field) => field.required).map((field) => {
      const result = results.find((entry) => entry.index === field.index);
      if (!empty(field) && field.element.getAttribute("aria-invalid") !== "true") return { index: field.index, concept: classifyField(field), status: "FILLED" };
      if (result?.reason === "UNSUPPORTED_CONTROL") return { index: field.index, concept: classifyField(field), status: "UNSUPPORTED" };
      if (result?.reason?.includes("LEGAL") || result?.reason?.includes("SENSITIVE") || result?.reason === "NO_APPROVED_ANSWER") return { index: field.index, concept: classifyField(field), status: "NEEDS_USER", reason: result.reason };
      return { index: field.index, concept: classifyField(field), status: "BLOCKED", reason: result?.reason || "REQUIRED_FIELD_EMPTY" };
    });
  }

  function blockers() {
    const body = clean(document.body?.innerText).slice(0, 30_000);
    const hasVisible = (selector) => Array.from(document.querySelectorAll(selector)).some(visible);
    const hasVisibleAction = (pattern) => Array.from(document.querySelectorAll("button,a,[role='button']"))
      .some((element) => visible(element) && pattern.test(clean(element.textContent || element.getAttribute("aria-label"))));
    if (hasVisible("iframe[src*='recaptcha'],iframe[src*='hcaptcha'],iframe[src*='challenges.cloudflare.com'],[class*='captcha' i],[id*='captcha' i]")) return [{ kind: "captcha", code: "USER_INTERVENTION_REQUIRED", detail: "Complete the CAPTCHA, then resume." }];
    if (hasVisible("input[autocomplete='one-time-code'],input[name*='otp' i],input[id*='otp' i],input[aria-label*='verification code' i]") || /\b(mfa|otp|multi.factor|two.factor|security code|verification code|authenticator code)\b/i.test(body)) return [{ kind: "mfa", code: "USER_INTERVENTION_REQUIRED", detail: "Complete MFA or verification, then resume." }];
    if (/\bstart your application\b/i.test(body) && hasVisibleAction(/^sign in$/i)) return [{ kind: "account_creation", code: "ACCOUNT_CREATION_REQUIRED", detail: "Start or sign in to the employer account yourself, then resume." }];
    if (hasVisible("input[type='password']") && /\b(create|register|set up).*\b(account|password)\b/i.test(body)) return [{ kind: "account_creation", code: "ACCOUNT_CREATION_REQUIRED", detail: "Create and verify the employer account yourself, then resume." }];
    if (hasVisible("input[type='password']")) return [{ kind: "login", code: "USER_INTERVENTION_REQUIRED", detail: "Sign in yourself, then resume." }];
    if (/\belectronic signature|arbitration agreement|background.check consent\b/i.test(body)) return [{ kind: "legal", code: "USER_INTERVENTION_REQUIRED", detail: "A legal agreement or signature requires your review." }];
    return [];
  }

  function actionText(element) {
    return clean([element.textContent, element.getAttribute("value"), element.getAttribute("aria-label"), element.getAttribute("title")].filter(Boolean).join(" "));
  }
  const isFinalAction = (element) => FINAL_ACTION.test(actionText(element)) && !NEXT_ACTION.test(actionText(element));
  function nextAction() {
    return Array.from(document.querySelectorAll("button,input[type='button'],input[type='submit'],a[role='button']"))
      .filter(visible).find((element) => NEXT_ACTION.test(actionText(element)) && !isFinalAction(element) && element.getAttribute("aria-disabled") !== "true" && !element.disabled) || null;
  }
  function finalAction() {
    return Array.from(document.querySelectorAll("button,input[type='submit'],[role='button']")).filter(visible).find(isFinalAction) || null;
  }
  function validationErrors() {
    return Array.from(document.querySelectorAll("[aria-invalid='true'],[role='alert'],.error,.field-error,[data-automation-id*='error']"))
      .filter(visible).map((element) => clean(element.textContent || element.getAttribute("aria-label"))).filter(Boolean).slice(0, 50);
  }

  globalThis.InternshipPilotAutofillEngine = {
    scanFields, serializeField, classifyField, answerFor, equivalentScore, bestOption,
    fillField, requiredAudit, blockers, nextAction, finalAction, isFinalAction,
    validationErrors, clean, visible,
  };
})();
