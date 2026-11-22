import type { CandidateFact } from "@/lib/validation";

const KNOWN_TECHNICAL_SKILLS = [
  "TypeScript",
  "JavaScript",
  "Python",
  "C++",
  "C#",
  "Java",
  "Go",
  "Rust",
  "SQL",
  "React",
  "Next.js",
  "Node.js",
  "PostgreSQL",
  "MySQL",
  "MongoDB",
  "Redis",
  "Docker",
  "Kubernetes",
  "AWS",
  "GCP",
  "Azure",
  "Linux",
  "Git",
  "PyTorch",
  "TensorFlow",
  "Scikit-Learn",
  "GraphQL",
  "REST",
  "HTML",
  "CSS",
  "Tailwind CSS",
  "FastAPI",
  "Flask",
  "Django",
  "Spring Boot",
  "Embedded Systems",
  "Verilog",
  "VHDL",
  "FPGA",
  "MATLAB",
  "SolidWorks",
  "AutoCAD",
  "KiCad",
  "Altium",
  "ROS",
  "STM32",
  "Arduino",
  "Terraform",
  "Prisma",
  "Playwright",
];

type SectionKind =
  | "header"
  | "education"
  | "skills"
  | "experience"
  | "projects"
  | "coursework"
  | "activities";

function detectSectionHeading(line: string): SectionKind | null {
  const clean = line
    .trim()
    .replace(/[:\-–—_]+$/g, "")
    .replace(/^[•*\-\d.)\s]+/, "")
    .trim()
    .toLowerCase();
  if (!clean || clean.length > 48) return null;

  if (/^(education|academic background|academics)$/.test(clean)) return "education";
  if (/^(technical\s+skills?|skills?|skills?\s*&\s*tools?|technologies|core\s+competencies|programming\s+languages)$/.test(clean)) {
    return "skills";
  }
  if (/^(experience|work\s+experience|professional\s+experience|engineering\s+experience|internships?|employment)$/.test(clean)) {
    return "experience";
  }
  if (/^(projects?|technical\s+projects?|personal\s+projects?|selected\s+projects?|academic\s+projects?)$/.test(clean)) {
    return "projects";
  }
  if (/^(coursework|relevant\s+coursework|courses)$/.test(clean)) return "coursework";
  if (/^(activities|extracurriculars?|leadership|involvement|clubs?|organizations?|honors?\s*&\s*awards?|awards?)$/.test(clean)) {
    return "activities";
  }
  return null;
}

function cleanLine(line: string): string {
  return line
    .replace(/\u00a0/g, " ")
    .replace(/^[•●▪▫‣◦\-*]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addFact(
  facts: CandidateFact[],
  seen: Set<string>,
  fact: CandidateFact,
): void {
  const content = fact.content.trim().slice(0, 480);
  const detail = fact.detail?.trim() ? fact.detail.trim().slice(0, 190) : null;
  if (!content) return;
  const key =
    fact.type === "skill"
      ? `skill::${content.toLowerCase()}`
      : `${fact.type}::${content.toLowerCase()}::${detail?.toLowerCase() ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  facts.push({ type: fact.type, content, detail });
}

function extractGpaFromText(text: string): string | null {
  const m = text.match(/\bGPA\s*[:\-]?\s*([0-4](?:\.\d{1,3})?)(?:\s*\/\s*4(?:\.0+)?)?/i);
  if (!m?.[1]) return null;
  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0 || num > 4.0) return null;
  return m[0].replace(/\s+/g, " ").trim();
}

function extractGraduationFromText(text: string): string | null {
  const patterns = [
    /\bExpected(?:\s+Graduation)?\s*[:\-]?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Spring|Summer|Fall|Winter)\s+20\d{2}\b/i,
    /\bGraduation\s*[:\-]?\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Spring|Summer|Fall|Winter)?\s*20\d{2}\b/i,
    /\bClass of\s+20\d{2}\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[0]) return m[0].replace(/\s+/g, " ").trim();
  }
  return null;
}

function extractInlineSkills(line: string): string[] {
  const stripped = line.replace(/^[A-Za-z\s/&]+:\s*/, "");
  return stripped
    .split(/[,|•;/]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 42 && !/^\d+$/.test(token));
}

function extractKnownSkillsInText(text: string): string[] {
  const matched: string[] = [];
  for (const skill of KNOWN_TECHNICAL_SKILLS) {
    const escaped = escapeRegex(skill);
    const re = skill.length <= 3
      ? new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, "i")
      : new RegExp(`(?:^|[^A-Za-z0-9+#.])${escaped}(?=$|[^A-Za-z0-9+#.])`, "i");
    if (re.test(text)) matched.push(skill);
  }
  return matched;
}

/**
 * Deterministic literal resume-evidence extractor.
 *
 * Extracts ONLY statements literally present in `resumeText` without inferring
 * or fabricating qualifications. Serves as the universal offline / fallback
 * extractor when hosted Gemini or local Ollama models are unavailable.
 */
export function extractLiteralFactsFromResumeText(resumeText: string): CandidateFact[] {
  const text = resumeText.trim();
  if (text.length < 20) return [];

  const facts: CandidateFact[] = [];
  const seen = new Set<string>();

  const rawLines = text.split(/\r?\n/);
  const sections: Record<SectionKind, string[]> = {
    header: [],
    education: [],
    skills: [],
    experience: [],
    projects: [],
    coursework: [],
    activities: [],
  };

  let current: SectionKind = "header";
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const heading = detectSectionHeading(trimmed);
    if (heading) {
      current = heading;
      continue;
    }
    sections[current].push(trimmed);
  }

  // 1. Education facts
  for (const rawLine of sections.education) {
    const line = cleanLine(rawLine);
    if (!line || line.length < 4) continue;

    if (/^(relevant\s+)?coursework\s*:/i.test(line)) {
      const list = line.replace(/^(relevant\s+)?coursework\s*:\s*/i, "");
      for (const course of extractInlineSkills(list)) {
        addFact(facts, seen, { type: "coursework", content: course, detail: "Resume Education" });
      }
      continue;
    }

    const gpa = extractGpaFromText(line);
    if (gpa) {
      addFact(facts, seen, { type: "gpa", content: gpa, detail: "Resume Education" });
    }

    const grad = extractGraduationFromText(line);
    if (grad) {
      addFact(facts, seen, { type: "graduationDate", content: grad, detail: "Resume Education" });
    }

    if (
      /university|college|institute|school|academy|b\.?s\.?|b\.?a\.?|m\.?s\.?|bachelor|master|ph\.?d|computer|engineering|mathematics|science/i.test(
        line,
      )
    ) {
      addFact(facts, seen, { type: "education", content: line, detail: null });
    }
  }

  // Global GPA / graduation fallback if written outside explicit Education heading
  if (!facts.some((f) => f.type === "gpa")) {
    const gpa = extractGpaFromText(text);
    if (gpa) addFact(facts, seen, { type: "gpa", content: gpa, detail: null });
  }
  if (!facts.some((f) => f.type === "graduationDate")) {
    const grad = extractGraduationFromText(text);
    if (grad) addFact(facts, seen, { type: "graduationDate", content: grad, detail: null });
  }

  // 2. Coursework section
  for (const rawLine of sections.coursework) {
    const line = cleanLine(rawLine);
    for (const course of extractInlineSkills(line)) {
      addFact(facts, seen, { type: "coursework", content: course, detail: null });
    }
  }

  // 3. Skills section + literal keyword matches from resume text
  for (const rawLine of sections.skills) {
    const line = cleanLine(rawLine);
    if (!line) continue;
    const categoryMatch = line.match(/^([A-Za-z\s/&]{2,32}):\s*(.+)$/);
    const detail = categoryMatch ? categoryMatch[1].trim() : "Technical Skills";
    for (const item of extractInlineSkills(line)) {
      addFact(facts, seen, { type: "skill", content: item, detail });
    }
  }
  for (const knownSkill of extractKnownSkillsInText(text)) {
    addFact(facts, seen, { type: "skill", content: knownSkill, detail: "Mentioned in resume" });
  }

  // 4. Experience section
  let currentExpHeader: string | null = null;
  for (const rawLine of sections.experience) {
    const isBullet = /^\s*[•●▪▫‣◦\-*]/.test(rawLine);
    const line = cleanLine(rawLine);
    if (line.length < 8) continue;

    if (
      !isBullet &&
      (/\b(?:intern|engineer|developer|research|assistant|fellow|analyst|associate|software|20\d{2})\b/i.test(line) ||
        line.includes("|") ||
        line.includes("—") ||
        line.includes(" - "))
    ) {
      currentExpHeader = line.slice(0, 140);
      addFact(facts, seen, { type: "experience", content: line, detail: null });
    } else {
      addFact(facts, seen, {
        type: "experience",
        content: line,
        detail: currentExpHeader,
      });
    }
  }

  // 5. Projects section
  let currentProjectHeader: string | null = null;
  for (const rawLine of sections.projects) {
    const isBullet = /^\s*[•●▪▫‣◦\-*]/.test(rawLine);
    const line = cleanLine(rawLine);
    if (line.length < 8) continue;

    if (!isBullet && (line.includes(":") || line.includes("|") || line.includes("—") || line.length <= 90)) {
      currentProjectHeader = line.split(/[:|—]/)[0]?.trim().slice(0, 120) || null;
      addFact(facts, seen, { type: "project", content: line, detail: currentProjectHeader });
    } else {
      addFact(facts, seen, {
        type: "project",
        content: line,
        detail: currentProjectHeader,
      });
    }
  }

  // 6. Activities / Leadership section
  for (const rawLine of sections.activities) {
    const line = cleanLine(rawLine);
    if (line.length >= 6) {
      addFact(facts, seen, { type: "activity", content: line, detail: null });
    }
  }

  // Fallback for unstructured single-column resumes without standard headings
  if (facts.length < 3) {
    for (const rawLine of rawLines) {
      const line = cleanLine(rawLine);
      if (line.length < 12) continue;
      if (/@|https?:\/\//i.test(line)) continue;
      if (/university|college|institute|b\.?s\.?|bachelor|master/i.test(line)) {
        addFact(facts, seen, { type: "education", content: line, detail: null });
      } else if (/\bintern\b|\bengineer\b|\bbuilt\b|\bdeveloped\b|\bdesigned\b|\bimplemented\b/i.test(line)) {
        addFact(facts, seen, { type: "experience", content: line, detail: null });
      } else if (facts.length < 15) {
        addFact(facts, seen, { type: "experience", content: line, detail: "Resume" });
      }
    }
  }

  return facts.slice(0, 65);
}

export type ExtractedResumeProfileFields = {
  fullName?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  github?: string;
  website?: string;
  school?: string;
  major?: string;
  gpa?: string;
  graduationDate?: string;
};

/**
 * Extract contact & core education fields directly written in the resume text
 * so a new account gets a working autofill/profile record automatically on upload.
 */
export function extractProfileFieldsFromResumeText(resumeText: string): ExtractedResumeProfileFields {
  const result: ExtractedResumeProfileFields = {};
  const lines = resumeText
    .split(/\r?\n/)
    .map((l) => cleanLine(l))
    .filter(Boolean);

  if (lines.length > 0) {
    const first = lines[0];
    if (
      first.length >= 3 &&
      first.length <= 64 &&
      !/[@\d]|https?:|resume|curriculum/i.test(first) &&
      first.split(/\s+/).length >= 2 &&
      first.split(/\s+/).length <= 5
    ) {
      result.fullName = first;
    }
  }

  const emailMatch = resumeText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch?.[0]) result.email = emailMatch[0];

  const phoneMatch = resumeText.match(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]*\d{3}[\s.-]\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{10}\b)/);
  if (phoneMatch?.[0]) result.phone = phoneMatch[0].trim();

  const linkedinMatch = resumeText.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i);
  if (linkedinMatch?.[0]) {
    result.linkedin = linkedinMatch[0].startsWith("http")
      ? linkedinMatch[0]
      : `https://${linkedinMatch[0]}`;
  }

  const githubMatch = resumeText.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_-]+/i);
  if (githubMatch?.[0]) {
    result.github = githubMatch[0].startsWith("http")
      ? githubMatch[0]
      : `https://${githubMatch[0]}`;
  }

  const portfolioMatch = resumeText.match(/(?:Portfolio|Website)\s*[:\-]\s*(?:https?:\/\/)?([A-Za-z0-9.-]+\.[a-z]{2,}(?:\/[^\s|•]*)?)/i);
  if (portfolioMatch?.[1]) {
    result.website = portfolioMatch[1].startsWith("http")
      ? portfolioMatch[1]
      : `https://${portfolioMatch[1]}`;
  }

  const rawLines = resumeText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rawSchoolLine = rawLines.find((l) =>
    /\b(?:university|college|institute of technology|polytechnic)\b/i.test(l) && l.length <= 120,
  );
  if (rawSchoolLine) {
    result.school = cleanLine(rawSchoolLine.split(/[|•,\t]|\s{2,}/)[0] ?? rawSchoolLine);
  }

  const majorMatch = resumeText.match(
    /(?:B\.?S\.?|B\.?A\.?|B\.?E\.?|M\.?S\.?|Bachelor(?:'s)?(?:\s+of\s+Science)?|Master(?:'s)?)\s+(?:in\s+)?([A-Za-z &/]{3,48})/i,
  );
  if (majorMatch?.[1]) {
    result.major = majorMatch[1]
      .split(/[|,•\t\n]/)[0]
      ?.replace(/\s+(?:Expected|Class|Dean|GPA|Sep|May)\b.*$/i, "")
      .trim();
  }

  const gpaNum = resumeText.match(/\bGPA\s*[:\-]?\s*([0-4](?:\.\d{1,2})?)/i);
  if (gpaNum?.[1]) result.gpa = gpaNum[1];

  const gradMatch = resumeText.match(
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(202\d)\b/i,
  );
  if (gradMatch?.[0]) {
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mIdx = monthNames.findIndex((m) => gradMatch[0].toLowerCase().startsWith(m));
    if (mIdx >= 0 && gradMatch[1]) {
      result.graduationDate = `${gradMatch[1]}-${String(mIdx + 1).padStart(2, "0")}`;
    }
  }

  return result;
}
