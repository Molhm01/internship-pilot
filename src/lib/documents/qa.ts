// Document QA (Milestone 5, points 10-12): re-extract the compiled PDF's
// text and check it the same way a human proofreader would — for the
// mechanical failure modes PDF generation can introduce (merged words, bad
// reading order) and for the one thing that must never silently drift:
// dates/GPA/metrics not matching the locked facts they came from.

// NOTE: a naive "lowercase followed by 2+ uppercase letters" regex sounds
// like a good merged-word detector, but it false-positives constantly on
// real, correctly-spelled tech proper nouns a CS/engineering resume is full
// of — PostgreSQL, JavaScript, TypeScript, GitHub, LinkedIn, iOS. Rather than
// maintain an ever-growing allowlist, we check something we actually know
// the ground truth for: OUR OWN section headings. If one of our fixed
// template's headings (EDUCATION, SKILLS, etc.) is found glued directly onto
// the previous character with no space/newline before it, that's the real
// "missing space" PDF-generation defect this check exists to catch.
export function checkMergedWordsAndSpacing(text: string, knownHeadings: string[] = []): string[] {
  const issues: string[] = [];

  for (const heading of knownHeadings) {
    const idx = text.indexOf(heading);
    if (idx <= 0) continue; // not found, or at the very start of the text — fine either way
    const precedingChar = text[idx - 1];
    if (!/\s/.test(precedingChar)) {
      issues.push(`Heading "${heading}" appears glued to the preceding text with no space/line break: "...${precedingChar}${heading}..."`);
    }
  }

  // A truly extreme unbroken run (60+ chars, longer than any real word,
  // acronym, or URL a resume would contain) is still a reasonable backstop
  // for pathological cases without flagging normal compound tech terms.
  const longRuns = Array.from(new Set(text.match(/\S{60,}/g) ?? []));
  if (longRuns.length > 0) {
    issues.push(`Unbroken text run(s) of 60+ characters, possible missing spaces: ${longRuns.slice(0, 3).join(", ")}`);
  }

  return issues;
}

export function checkHeadingOrder(text: string, expectedHeadingsInOrder: string[]): string[] {
  const issues: string[] = [];
  let lastIndex = -1;
  for (const heading of expectedHeadingsInOrder) {
    const idx = text.indexOf(heading);
    if (idx === -1) continue; // section legitimately empty/omitted — not an error
    if (idx < lastIndex) {
      issues.push(`Section "${heading}" appears out of the expected reading order.`);
    }
    lastIndex = idx;
  }
  return issues;
}

// Confirms specific fact-derived strings (dates, GPA, degree name, etc.)
// survived into the compiled PDF's extracted text byte-for-byte. Catches
// both PDF-extraction corruption AND any accidental rewording of a fact that
// should never change.
export function checkCriticalTextPreserved(text: string, criticalStrings: string[]): string[] {
  const issues: string[] = [];
  const normalized = text.replace(/\s+/g, " ");
  for (const s of criticalStrings) {
    const target = s.replace(/\s+/g, " ").trim();
    if (!target) continue;
    if (!normalized.includes(target)) {
      issues.push(`Expected text "${s}" was not found verbatim in the generated document.`);
    }
  }
  return issues;
}

export type QaResult = { status: "pass" | "fail"; issues: string[] };

export type DocumentQaOptions = {
  kind?: "resume" | "coverLetter";
  candidateName?: string;
  contactValues?: string[];
  requiredHeadings?: string[];
  forbiddenText?: RegExp[];
  requiredProjectTitles?: string[];
  pageCount?: number;
  wordCount?: number;
};

export function evaluateDocumentQa(
  extractedText: string,
  expectedHeadingsInOrder: string[],
  criticalStrings: string[],
): QaResult {
  const issues = [
    ...checkMergedWordsAndSpacing(extractedText, expectedHeadingsInOrder),
    ...checkHeadingOrder(extractedText, expectedHeadingsInOrder),
    ...checkCriticalTextPreserved(extractedText, criticalStrings),
  ];
  return { status: issues.length === 0 ? "pass" : "fail", issues };
}

export function evaluateStrictDocumentQa(
  extractedText: string,
  expectedHeadingsInOrder: string[],
  criticalStrings: string[],
  options: DocumentQaOptions,
): QaResult {
  const normalized = extractedText.replace(/\s+/g, " ").trim();
  const issues = evaluateDocumentQa(extractedText, expectedHeadingsInOrder, criticalStrings).issues;
  if (!options.candidateName?.trim() || !normalized.includes(options.candidateName.trim())) {
    issues.push("Candidate name is missing from the document.");
  }
  if (options.contactValues && !options.contactValues.some((v) => v.trim() && normalized.includes(v.trim()))) {
    issues.push("Contact header is missing.");
  }
  for (const heading of options.requiredHeadings ?? []) {
    const start = normalized.indexOf(heading);
    if (start < 0) issues.push(`Required section "${heading}" is missing.`);
    else {
      const after = normalized.slice(start + heading.length).trim();
      if (!after || (options.requiredHeadings ?? []).some((h) => after === h || after.startsWith(`${h} `))) {
        issues.push(`Required section "${heading}" is empty.`);
      }
    }
  }
  if (/Expected\s+(?:graduation:\s*)?Expected/i.test(normalized)) issues.push('"Expected" is duplicated.');
  for (const pattern of options.forbiddenText ?? []) {
    pattern.lastIndex = 0;
    if (pattern.test(normalized)) issues.push(`Forbidden or placeholder text matched ${pattern}.`);
  }
  for (const title of options.requiredProjectTitles ?? []) {
    if (!normalized.includes(title.replace(/\s+/g, " ").trim())) issues.push(`Selected project title "${title}" is missing.`);
  }
  if (options.pageCount !== undefined && options.pageCount !== 1) issues.push(`Document must be one page; found ${options.pageCount}.`);
  if (options.kind === "resume") {
    const words = options.wordCount ?? normalized.split(/\s+/).filter(Boolean).length;
    if (words < 150) issues.push(`Resume has too little content (${words} words), indicating excessive unexplained whitespace.`);
    if (/\S\|\S/.test(extractedText)) issues.push("Contact separators must include spacing around each vertical bar.");
    if (/\w-\s*\n\s*[a-z]/.test(extractedText)) issues.push("A word is split awkwardly across two lines.");
  }
  if (options.kind === "coverLetter") {
    if (!/Dear .+ Hiring Team,/.test(normalized)) issues.push("Cover letter greeting is missing.");
    if (!normalized.includes("Sincerely,")) issues.push("Cover letter closing is missing.");
    const words = options.wordCount ?? normalized.split(/\s+/).filter(Boolean).length;
    if (words < 180 || words > 260) issues.push(`Cover letter must be 180–260 words; found ${words}.`);
  }
  return { status: issues.length ? "fail" : "pass", issues };
}
