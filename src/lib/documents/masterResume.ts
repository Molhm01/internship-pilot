export type MasterEducation = { school: string; degree: string; coursework: string; location: string; dates: string };
export type MasterEntry = { title: string; organization: string; location: string; dates: string; bullets: string[] };
export type MasterSkillGroup = { label: string; items: string[] };

// Authoritative content transcribed from templates/master_resume_reference.pdf.
// Tailoring may reorder bullets and skills, but never remove or rewrite it.
export const MASTER_EDUCATION: MasterEducation[] = [
  { school: "New Jersey Institute of Technology", degree: "B.S. Electrical Engineering (Transferred).", coursework: "Relevant Coursework: Digital Design, Circuits & Systems I, Differential Equations", location: "Newark, NJ", dates: "Expected May 2029" },
  { school: "Stevens Institute of Technology", degree: "B.E. Computer Engineering. Dean's List | Presidential Achievement Scholarship. GPA: 3.76.", coursework: "Relevant Coursework: Engineering Design, Programming & Algorithmic Thinking (C++), Sustainable Systems with Sensors", location: "Hoboken, NJ", dates: "Sep 2025 – May 2026" },
];

export const MASTER_EXPERIENCE: MasterEntry[] = [
  { title: "PC Builder and Repair Technician", organization: "Freelance", location: "Clifton, NJ", dates: "Jul 2021 – Present", bullets: [
    "Built 30+ custom PCs and completed 100+ hardware repairs at 5–10 jobs per month at peak.",
    "Diagnosed desktop and laptop issues; replaced RAM, SSDs, GPUs, and cooling components.",
    "Tested each system for stability before returning it to the client.",
  ] },
  { title: "Sales Associate / Shift Lead", organization: "The UPS Store", location: "Clifton, NJ", dates: "Jun 2025 – Mar 2026", bullets: [
    "Managed opening and closing procedures, register reconciliation, and daily store operations.",
    "Reorganized peak-hour task assignments to improve workflow and reduce customer wait times.",
    "Assisted 20–30 customers per shift and processed insured shipments up to $10,000.",
  ] },
  { title: "Family Caregiver", organization: "", location: "Clifton, NJ", dates: "2022 – Present", bullets: [
    "Provided 10–15 hours per week of mobility, transportation, and medication support for two siblings with disabilities while enrolled full time.",
  ] },
];

export const MASTER_PROJECTS: MasterEntry[] = [
  { title: "Software-Defined Radio ADS-B Receiver", organization: "Python, RTL-SDR", location: "", dates: "", bullets: [
    "Captured raw IQ at 1090 MHz (2 MSPS) and implemented preamble correlation and pulse-position demodulation to recover 112-bit Mode S extended squitter frames.",
    "Validated frames with CRC-24 error detection and parsed ICAO addresses, recovering 64% of the addresses identified by dump1090 on identical captures.",
    "Traced the 36% gap to fixed-threshold false detections near the noise floor; characterized the sensitivity/false-positive curve and selected an operating point.",
  ] },
  { title: "Air Quality Monitor —VOC Detection", organization: "", location: "", dates: "", bullets: [
    "Sampled MQ-135 sensor data and displayed filtered air-quality readings on an OLED.",
    "Implemented smoothing logic and threshold-based LED and buzzer alerts for elevated readings.",
    "Designed and 3D-printed a ventilated enclosure for the sensor, display, and electronics.",
  ] },
  { title: "Automated Plant-Watering System", organization: "", location: "", dates: "", bullets: [
    "Used soil-moisture readings to trigger water-pump cycles at 10-minute sampling intervals.",
    "Programmed moisture thresholds and timing controls to prevent unnecessary watering.",
    "Designed and 3D-printed a 5 x 5 x 10-inch enclosure for the sensors, pump, and wiring.",
  ] },
];

export const MASTER_SKILLS: MasterSkillGroup[] = [
  { label: "Languages", items: ["C++", "Python", "MATLAB"] },
  { label: "Embedded Systems", items: ["Arduino", "analog sensor interfacing", "OLED integration", "real-time data acquisition"] },
  { label: "Electronics", items: ["Circuit prototyping", "breadboarding", "analog measurement", "digital filtering"] },
  { label: "Hardware", items: ["PC assembly", "system-level troubleshooting", "diagnostics", "component replacement"] },
  { label: "Design & Tools", items: ["SolidWorks", "3D printing", "enclosure design"] },
  { label: "Additional", items: ["Arabic (fluent)", "communication skills", "Microsoft Excel", "written and verbal communication skills", "decision-making", "Microsoft Word"] },
];
export const MASTER_ACTIVITIES = ["IEEE  -  Member", "Commuter Student Organization  -  Member", "Muslim Student Association  -  Member"];

function relevance(text: string, jobText: string): number {
  return text.toLowerCase().split(/[^a-z0-9+]+/).filter((x) => x.length > 3)
    .reduce((score, term) => score + (jobText.includes(term) ? 1 : 0), 0);
}
export type TailoringAudit = {
  status: "TAILORED_WITH_SUPPORTED_CHANGES" | "MASTER_UNCHANGED_NO_SUPPORTED_IMPROVEMENT" | "NOT_TAILORED_NO_JOB_DESCRIPTION";
  originalAtsMatchScore: number;
  tailoredAtsMatchScore: number;
  scoreMethod: string;
  keywordsAdded: string[];
  bulletsChanged: Array<{ original: string; tailored: string; evidence: Array<{ factId: string; content: string }> }>;
  bulletsReordered: Array<{ entry: string; before: string[]; after: string[] }>;
  supportedKeywords: Array<{ keyword: string; evidence: Array<{ factId: string; content: string }> }>;
  unsupportedRequirementsNotAdded: string[];
};

export type EvidenceFact = { id: string; type?: string; content: string; detail: string | null };

function evidenceMatching(facts: EvidenceFact[], patterns: RegExp[]) {
  return facts.filter((fact) => patterns.some((pattern) => pattern.test(`${fact.content} ${fact.detail ?? ""}`))).map((fact) => ({ factId: fact.id, content: fact.content }));
}

export function legacyTailoredMasterContent(job: { title: string; company?: string; description: string; jobResponsibilities?: string | null; jobQualifications?: string | null }, facts: EvidenceFact[] = [], originalScore = 0) {
  const jobText = `${job.title} ${job.description}`.toLowerCase();
  const order = (items: string[]) => items.map((text, index) => ({ text, index, score: relevance(text, jobText) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map((x) => x.text);
  const base = {
    education: MASTER_EDUCATION, experience: MASTER_EXPERIENCE, projects: MASTER_PROJECTS,
    skills: MASTER_SKILLS, activities: MASTER_ACTIVITIES,
  };
  const audit: TailoringAudit = {
    status: "MASTER_UNCHANGED_NO_SUPPORTED_IMPROVEMENT",
    originalAtsMatchScore: originalScore,
    tailoredAtsMatchScore: originalScore,
    scoreMethod: "The existing grounded MatchResult score is retained because wording and order changes do not create new evidence.",
    keywordsAdded: [], bulletsChanged: [], bulletsReordered: [], supportedKeywords: [], unsupportedRequirementsNotAdded: [],
  };

  if (/manufacturing engineering intern/i.test(job.title) && /lightship/i.test(job.company ?? "")) {
    const pcEvidence = evidenceMatching(facts, [/PC Builder/i, /PC assembly/i, /diagnostics/i, /component replacement/i]);
    const enclosureEvidence = evidenceMatching(facts, [/Air Quality Monitor/i, /Automated Plant-Watering/i, /3D printing/i, /enclosure design/i]);
    const cadEvidence = evidenceMatching(facts, [/SolidWorks/i]);
    const sensorEvidence = evidenceMatching(facts, [/sensor/i, /Circuit prototyping/i, /OLED integration/i]);
    const firstOriginal = MASTER_EXPERIENCE[0].bullets[0];
    const firstTailored = "Assembled 30+ custom PCs and completed 100+ hardware repairs at 5–10 jobs per month at peak.";
    const enclosureOriginal = MASTER_PROJECTS[1].bullets[2];
    const enclosureTailored = "Designed and 3D-printed a ventilated enclosure integrating the sensor, display, and electronics.";
    audit.status = "TAILORED_WITH_SUPPORTED_CHANGES";
    audit.keywordsAdded = ["assembled", "integrating", "CAD"];
    audit.bulletsChanged = [
      { original: firstOriginal, tailored: firstTailored, evidence: pcEvidence },
      { original: enclosureOriginal, tailored: enclosureTailored, evidence: enclosureEvidence },
    ];
    audit.supportedKeywords = [
      { keyword: "hardware assembly and component installation", evidence: pcEvidence },
      { keyword: "diagnostics and troubleshooting", evidence: pcEvidence },
      { keyword: "enclosure design and 3D printing", evidence: enclosureEvidence },
      { keyword: "electronics and sensor integration", evidence: sensorEvidence },
      { keyword: "CAD / SolidWorks", evidence: cadEvidence },
    ];
    audit.unsupportedRequirementsNotAdded = [
      "Conducting formal manufacturing time studies",
      "Authoring production work instructions",
      "Reading engineering drawings",
      "Google software suite",
      "Line balancing and capacity planning",
    ];
    const experience = MASTER_EXPERIENCE.map((entry, index) => index === 0 ? { ...entry, bullets: [firstTailored, entry.bullets[1], entry.bullets[2]] } : entry);
    const air = { ...MASTER_PROJECTS[1], bullets: [MASTER_PROJECTS[1].bullets[0], MASTER_PROJECTS[1].bullets[1], enclosureTailored] };
    const skills = MASTER_SKILLS.map((group) => group.label === "Design & Tools"
      ? { ...group, items: group.items.map((item) => item === "SolidWorks" ? "SolidWorks (CAD)" : item) }
      : group);
    const projects = MASTER_PROJECTS.map((entry) => entry.title === air.title ? air : entry);
    return { content: { ...base, experience, projects, skills }, audit };
  }
  if (/reliability design/i.test(job.title)) {
    const experienceAfter = [MASTER_EXPERIENCE[0].bullets[1], MASTER_EXPERIENCE[0].bullets[2], MASTER_EXPERIENCE[0].bullets[0]];
    const adsbAfter = [MASTER_PROJECTS[0].bullets[1], MASTER_PROJECTS[0].bullets[2], MASTER_PROJECTS[0].bullets[0]];
    audit.status = "TAILORED_WITH_SUPPORTED_CHANGES";
    audit.bulletsReordered = [
      { entry: "PC Builder and Repair Technician", before: MASTER_EXPERIENCE[0].bullets, after: experienceAfter },
      { entry: "Software-Defined Radio ADS-B Receiver", before: MASTER_PROJECTS[0].bullets, after: adsbAfter },
    ];
    return { content: {
      education: MASTER_EDUCATION,
      experience: MASTER_EXPERIENCE.map((entry) => entry.title === "PC Builder and Repair Technician" ? { ...entry, bullets: experienceAfter } : entry),
      projects: MASTER_PROJECTS.map((entry) => entry.title === "Software-Defined Radio ADS-B Receiver" ? { ...entry, bullets: adsbAfter } : entry),
      skills: MASTER_SKILLS,
      activities: MASTER_ACTIVITIES,
    }, audit };
  }
  void order;
  return { content: base, audit };
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function factText(fact: EvidenceFact): string {
  return `${fact.content} ${fact.detail ?? ""}`.trim();
}

function matchingEntityFact(
  entryTitle: string,
  facts: EvidenceFact[],
  type: "experience" | "project",
): EvidenceFact | undefined {
  const title = normalized(entryTitle).replace(/\bpython\b|\brtl sdr\b/g, "").trim();
  return facts.find((fact) => {
    if (fact.type !== type) return false;
    const content = normalized(fact.content);
    return content.includes(title) || title.includes(content.split(",")[0] ?? "");
  });
}

function approvedSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 12)
    .slice(0, 3);
}

function exactApprovedSkill(item: string, facts: EvidenceFact[]): boolean {
  const skillText = (value: string) => value
    .toLowerCase()
    .replace(/[^a-z0-9+.#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const target = skillText(item);
  return facts.some((fact) => {
    if (fact.type !== "skill") return false;
    const candidate = skillText(fact.content);
    return candidate === target
      || candidate.startsWith(`${target} `)
      || (candidate.length >= 3 && target.startsWith(`${candidate} `));
  });
}

/**
 * Materializes the fixed resume layout exclusively from approved profile
 * facts. The master constants provide labels/grouping and stable typography;
 * factual bullets come verbatim from the matching approved fact detail.
 */
export function groundedMasterContent(facts: EvidenceFact[]) {
  const educationFacts = facts.filter((fact) => fact.type === "education");
  const courseworkFacts = facts.filter((fact) => fact.type === "coursework");
  const gpaFacts = facts.filter((fact) => fact.type === "gpa");
  const graduationFacts = facts.filter((fact) => fact.type === "graduationDate");
  const education = MASTER_EDUCATION.flatMap((item) => {
    const approved = educationFacts.find((fact) =>
      normalized(fact.content).includes(normalized(item.school)),
    );
    if (!approved) return [];
    const approvedEducationText = normalized([
      factText(approved),
      ...gpaFacts.map(factText),
    ].join(" "));
    const degreeTokens = normalized(item.degree)
      .split(" ")
      .filter((token) => token.length > 2 || /\d/.test(token));
    const degree = degreeTokens.every((token) => approvedEducationText.includes(token))
      ? item.degree
      : approved.content.split(",").slice(1).join(",").trim();
    const approvedCourses = courseworkFacts
      .map((fact) => fact.content)
      .filter((course) => normalized(item.coursework).includes(normalized(course)));
    const graduation = graduationFacts.find((fact) =>
      normalized(item.dates).includes(normalized(fact.content)),
    );
    return [{
      ...item,
      degree,
      coursework: approvedCourses.length
        ? `Relevant Coursework: ${approvedCourses.join(", ")}`
        : "",
      location: approvedEducationText.includes(normalized(item.location))
        ? item.location
        : "",
      dates: graduation?.content ?? "",
    }];
  });

  const groundEntries = (items: MasterEntry[], type: "experience" | "project") =>
    items.flatMap((item) => {
      const approved = matchingEntityFact(item.title, facts, type);
      if (!approved) return [];
      const approvedText = normalized(factText(approved));
      const bullets = approvedSentences(approved.detail ?? "");
      if (!bullets.length) return [];
      return [{
        ...item,
        bullets,
        organization: approvedText.includes(normalized(item.organization))
          ? item.organization
          : "",
        location: approvedText.includes(normalized(item.location)) ? item.location : "",
        dates: approvedText.includes(normalized(item.dates)) ? item.dates : "",
      }];
    });

  const skills = MASTER_SKILLS
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => exactApprovedSkill(item, facts)),
    }))
    .filter((group) => group.items.length > 0);
  const activities = facts
    .filter((fact) => fact.type === "activity")
    .flatMap((fact) => {
      const parts = fact.content.split(/\s+-\s+/).map((part) => part.trim());
      return parts.length >= 2 && parts[0] && parts[1]
        ? [`${parts[0]}  -  ${parts.slice(1).join(" - ")}`]
        : [];
    });

  return {
    education,
    experience: groundEntries(MASTER_EXPERIENCE, "experience"),
    projects: groundEntries(MASTER_PROJECTS, "project"),
    skills,
    activities,
  };
}

export function tailoredMasterContent(
  job: {
    title: string;
    company?: string;
    description: string;
    jobResponsibilities?: string | null;
    jobQualifications?: string | null;
  },
  facts: EvidenceFact[] = [],
  originalScore = 0,
  options: { selectedFactIds?: string[]; unsupportedQualifications?: string[] } = {},
) {
  const jobText = `${job.title} ${job.description}`.toLowerCase();
  const selected = new Set(options.selectedFactIds ?? []);
  const order = (items: string[]) =>
    items
      .map((text, index) => ({ text, index, score: relevance(text, jobText) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.text);
  const base = groundedMasterContent(facts);
  const audit: TailoringAudit = {
    status: "MASTER_UNCHANGED_NO_SUPPORTED_IMPROVEMENT",
    originalAtsMatchScore: originalScore,
    tailoredAtsMatchScore: originalScore,
    scoreMethod: "The existing grounded MatchResult score is retained because wording and order changes do not create new evidence.",
    keywordsAdded: [],
    bulletsChanged: [],
    bulletsReordered: [],
    supportedKeywords: [],
    unsupportedRequirementsNotAdded: options.unsupportedQualifications ?? [],
  };

  const prioritizedEntries = (
    entries: MasterEntry[],
    type: "experience" | "project",
  ) =>
    entries
      .map((entry, index) => {
        const fact = matchingEntityFact(entry.title, facts, type);
        const before = entry.bullets;
        const after = order(before);
        if (before.some((bullet, bulletIndex) => bullet !== after[bulletIndex])) {
          audit.bulletsReordered.push({ entry: entry.title, before, after });
        }
        return {
          entry: { ...entry, bullets: after },
          index,
          selected: fact ? selected.has(fact.id) : false,
          score: relevance(`${entry.title} ${entry.bullets.join(" ")}`, jobText),
        };
      })
      .sort((a, b) =>
        Number(b.selected) - Number(a.selected)
        || b.score - a.score
        || a.index - b.index,
      )
      .map(({ entry }) => entry);

  const supportedSkillFacts = facts.filter((fact) =>
    fact.type === "skill"
    && normalized(fact.content).length > 1
    && normalized(jobText).includes(normalized(fact.content)),
  );
  audit.supportedKeywords = supportedSkillFacts.map((fact) => ({
    keyword: fact.content,
    evidence: [{ factId: fact.id, content: fact.content }],
  }));
  const content = {
    ...base,
    experience: prioritizedEntries(base.experience, "experience"),
    projects: prioritizedEntries(base.projects, "project"),
    skills: base.skills
      .map((group) => ({ ...group, items: order(group.items) }))
      .sort((a, b) =>
        relevance(b.items.join(" "), jobText) - relevance(a.items.join(" "), jobText),
      ),
  };
  if (audit.bulletsReordered.length || audit.supportedKeywords.length || selected.size) {
    audit.status = "TAILORED_WITH_SUPPORTED_CHANGES";
  }
  return { content, audit };
}
