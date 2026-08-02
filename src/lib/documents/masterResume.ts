export type MasterEducation = { school: string; degree: string; coursework: string; location: string; dates: string };
export type MasterEntry = { title: string; organization: string; location: string; dates: string; bullets: string[] };
export type MasterSkillGroup = { label: string; items: string[] };

// Authoritative content transcribed from templates/master_resume_reference.pdf.
// Tailoring may make audited, evidence-backed bullet substitutions and
// reorder content, but the master remains the canonical factual/layout source.
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
  { label: "Additional", items: ["Arabic (fluent)", "communication skills", "reliability testing", "Microsoft Excel", "written and verbal communication skills", "decision-making", "ai", "equipment calibration", "Microsoft Word"] },
];
export const MASTER_ACTIVITIES = ["IEEE  -  Member", "Commuter Student Organization  -  Member", "Muslim Student Association  -  Member"];

function relevance(text: string, jobText: string): number {
  return text.toLowerCase().split(/[^a-z0-9+]+/).filter((x) => x.length > 3)
    .reduce((score, term) => score + (jobText.includes(term) ? 1 : 0), 0);
}
export type TailoringAudit = {
  status: "TAILORED_WITH_SUPPORTED_CHANGES" | "NO_SUPPORTED_TAILORING_CHANGES" | "MASTER_UNCHANGED_NO_SUPPORTED_IMPROVEMENT" | "NOT_TAILORED_NO_JOB_DESCRIPTION";
  originalAtsMatchScore: number;
  tailoredAtsMatchScore: number;
  scoreMethod: string;
  keywordsAdded: string[];
  bulletsChanged: Array<{ original: string; tailored: string; evidence: Array<{ factId: string; content: string }>; jobRequirementAddressed?: string }>;
  bulletsReordered: Array<{ entry: string; before: string[]; after: string[] }>;
  skillsReordered?: Array<{ group: string; before: string[]; after: string[] }>;
  supportedKeywords: Array<{ keyword: string; evidence: Array<{ factId: string; content: string }> }>;
  unsupportedRequirementsNotAdded: string[];
  unsupportedWordingRemoved?: Array<{ phrase: string; sourceSection: string; reason: string }>;
  formattingPreservation?: { status: "pass" | "fail"; method: string; issues: string[] };
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

/**
 * Returns a defensive copy of the approved master résumé transcription. The
 * master PDF—not a partial extraction—is the canonical factual and structural
 * source, so missing parser rows cannot collapse the original layout.
 */
export function groundedMasterContent(facts: EvidenceFact[]) {
  void facts;
  return {
    education: MASTER_EDUCATION.map((item) => ({ ...item })),
    experience: MASTER_EXPERIENCE.map((item) => ({ ...item, bullets: [...item.bullets] })),
    projects: MASTER_PROJECTS.map((item) => ({ ...item, bullets: [...item.bullets] })),
    skills: MASTER_SKILLS.map((group) => ({ ...group, items: [...group.items] })),
    activities: [...MASTER_ACTIVITIES],
  };
}

type TransferableCompetencyRule = {
  competency: string;
  requirementPattern: RegExp;
  entryType: "experience" | "project";
  entryTitle: string;
  original: string;
  tailored: string;
  keywordsAdded: string[];
  evidencePatterns: RegExp[];
};

const TRANSFERABLE_COMPETENCY_RULES: TransferableCompetencyRule[] = [
  {
    competency: "analytical ability",
    requirementPattern: /\banalyt(?:ical|ics|ze|zed|zing)\b|critical thinking/i,
    entryType: "project",
    entryTitle: "Software-Defined Radio ADS-B Receiver",
    original: MASTER_PROJECTS[0].bullets[0],
    tailored: "Analyzed raw IQ data at 1090 MHz and implemented preamble correlation and pulse-position demodulation to recover 112-bit Mode S frames.",
    keywordsAdded: ["Analyzed"],
    evidencePatterns: [/raw IQ/i, /preamble correlation/i, /pulse-position demodulation/i],
  },
  {
    competency: "problem solving",
    requirementPattern: /problem[- ]solv|troubleshoot|diagnos|resolve (?:technical )?issues/i,
    entryType: "experience",
    entryTitle: "PC Builder and Repair Technician",
    original: MASTER_EXPERIENCE[0].bullets[1],
    tailored: "Diagnosed and resolved desktop and laptop hardware failures by testing and replacing RAM, SSDs, GPUs, and cooling components.",
    keywordsAdded: ["resolved", "hardware failures"],
    evidencePatterns: [/100\+ hardware repairs/i, /diagnosed desktop and laptop/i, /replaced RAM/i],
  },
  {
    competency: "collaboration",
    requirementPattern: /collaborat|teamwork|work (?:effectively )?(?:with|on) (?:a )?team|coworker/i,
    entryType: "experience",
    entryTitle: "Sales Associate / Shift Lead",
    original: MASTER_EXPERIENCE[1].bullets[1],
    tailored: "Coordinated peak-hour task assignments with coworkers to improve workflow and reduce customer wait times.",
    keywordsAdded: ["Coordinated", "coworkers"],
    evidencePatterns: [/shift lead/i, /task assignments/i, /daily store operations/i],
  },
  {
    competency: "communication",
    requirementPattern: /\bcommunicat|customer[- ]facing|interpersonal/i,
    entryType: "experience",
    entryTitle: "Sales Associate / Shift Lead",
    original: MASTER_EXPERIENCE[1].bullets[2],
    tailored: "Communicated with and assisted 20–30 customers per shift while processing insured shipments up to $10,000.",
    keywordsAdded: ["Communicated"],
    evidencePatterns: [/20–30 customers per shift/i, /daily store operations/i],
  },
  {
    competency: "technical learning",
    requirementPattern: /technical learning|learn quickly|learning agility|adaptab/i,
    entryType: "project",
    entryTitle: "Automated Plant-Watering System",
    original: MASTER_PROJECTS[2].bullets[1],
    tailored: "Programmed and refined moisture thresholds and timing controls to prevent unnecessary watering.",
    keywordsAdded: ["refined"],
    evidencePatterns: [/programmed moisture thresholds/i, /timing controls/i],
  },
];

export type SupportedTransferableCompetency = {
  competency: string;
  jobRequirement: string;
  evidence: Array<{ factId: string; content: string }>;
  originalBullet: string;
  tailoredBullet: string;
  keywordsAdded: string[];
};

function evidenceForCompetency(
  rule: TransferableCompetencyRule,
  facts: EvidenceFact[],
): Array<{ factId: string; content: string }> {
  const matchingFacts = evidenceMatching(facts, rule.evidencePatterns);
  return matchingFacts.length
    ? matchingFacts
    : [{ factId: "master-resume", content: rule.original }];
}

export function isSupportedTransferableRequirement(requirement: string): boolean {
  return TRANSFERABLE_COMPETENCY_RULES.some((rule) =>
    rule.requirementPattern.test(requirement),
  );
}

export function recognizeSupportedTransferableCompetencies(
  jobText: string,
  facts: EvidenceFact[] = [],
  requirementCandidates: string[] = [],
): SupportedTransferableCompetency[] {
  const combined = [jobText, ...requirementCandidates].join("\n");
  return TRANSFERABLE_COMPETENCY_RULES.flatMap((rule) => {
    if (!rule.requirementPattern.test(combined)) return [];
    const exactRequirement = requirementCandidates.find((requirement) =>
      rule.requirementPattern.test(requirement),
    );
    return [{
      competency: rule.competency,
      jobRequirement: exactRequirement ?? rule.competency,
      evidence: evidenceForCompetency(rule, facts),
      originalBullet: rule.original,
      tailoredBullet: rule.tailored,
      keywordsAdded: rule.keywordsAdded,
    }];
  });
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
  options: { selectedFactIds?: string[]; unsupportedQualifications?: string[]; supportedRequirements?: string[] } = {},
) {
  const jobText = `${job.title} ${job.description}`.toLowerCase();
  const order = (items: string[]) =>
    items
      .map((text, index) => ({ text, index, score: relevance(text, jobText) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.text);
  const base = groundedMasterContent(facts);
  const audit: TailoringAudit = {
    status: "NO_SUPPORTED_TAILORING_CHANGES",
    originalAtsMatchScore: originalScore,
    tailoredAtsMatchScore: originalScore,
    scoreMethod: "No safe content change was available, so the grounded AI Match score was intentionally left unchanged.",
    keywordsAdded: [],
    bulletsChanged: [],
    bulletsReordered: [],
    skillsReordered: [],
    supportedKeywords: [],
    unsupportedRequirementsNotAdded: options.unsupportedQualifications ?? [],
  };
  const competencies = recognizeSupportedTransferableCompetencies(
    jobText,
    facts,
    options.supportedRequirements ?? [],
  );
  const tailoredEntries = (
    entries: MasterEntry[],
    type: "experience" | "project",
  ) =>
    entries.map((entry) => {
      const transformed = entry.bullets.map((original, index) => {
        const competency = competencies.find((item) =>
          item.originalBullet === original
          && TRANSFERABLE_COMPETENCY_RULES.some((rule) =>
            rule.competency === item.competency
            && rule.entryType === type
            && rule.entryTitle === entry.title,
          ),
        );
        if (!competency) return { original, text: original, index };
        audit.bulletsChanged.push({
          original,
          tailored: competency.tailoredBullet,
          evidence: competency.evidence,
          jobRequirementAddressed: competency.jobRequirement,
        });
        audit.keywordsAdded.push(...competency.keywordsAdded);
        return { original, text: competency.tailoredBullet, index };
      });
      const reordered = transformed
        .map((item) => ({ ...item, score: relevance(item.text, jobText) }))
        .sort((left, right) => right.score - left.score || left.index - right.index);
      const beforeOrder = transformed.map((item) => item.original);
      const afterOriginalOrder = reordered.map((item) => item.original);
      const after = reordered.map((item) => item.text);
      if (beforeOrder.some((bullet, index) => bullet !== afterOriginalOrder[index])) {
        audit.bulletsReordered.push({ entry: entry.title, before: beforeOrder, after });
      }
      return { ...entry, bullets: after };
    });

  const skills = base.skills.map((group) => {
    const before = group.items;
    const after = order(before);
    if (before.some((item, index) => item !== after[index])) {
      audit.skillsReordered?.push({ group: group.label, before, after });
    }
    return { ...group, items: after };
  });
  const supportedMasterSkills = base.skills.flatMap((group) => group.items)
    .filter((skill) => {
      const value = normalized(skill);
      const explicitlyUnsupported = (options.unsupportedQualifications ?? [])
        .some((requirement) => normalized(requirement) === value);
      return value.length > 1 && normalized(jobText).includes(value) && !explicitlyUnsupported;
    })
    .map((skill) => ({
      keyword: skill,
      evidence: [{ factId: "master-resume", content: skill }],
    }));
  const supportedCompetencies = competencies.map((competency) => ({
    keyword: competency.competency,
    evidence: competency.evidence,
  }));
  const supportedByKeyword = new Map<string, { keyword: string; evidence: Array<{ factId: string; content: string }> }>();
  for (const item of [...supportedMasterSkills, ...supportedCompetencies]) {
    supportedByKeyword.set(item.keyword.toLowerCase(), item);
  }
  audit.supportedKeywords = [...supportedByKeyword.values()];
  audit.keywordsAdded = [...new Set(audit.keywordsAdded)];

  const content = {
    ...base,
    experience: tailoredEntries(base.experience, "experience"),
    projects: tailoredEntries(base.projects, "project"),
    skills,
  };
  const meaningfulChangeCount = audit.bulletsChanged.length
    + audit.bulletsReordered.length
    + (audit.skillsReordered?.length ?? 0);
  if (meaningfulChangeCount > 0) {
    const keywordCoverageDelta = Math.max(1, audit.keywordsAdded.length);
    audit.status = "TAILORED_WITH_SUPPORTED_CHANGES";
    audit.tailoredAtsMatchScore = Math.min(100, originalScore + keywordCoverageDelta);
    audit.scoreMethod = audit.tailoredAtsMatchScore === originalScore
      ? "Supported job terminology was added, but the score remained at the 100-point cap; no evidence was inflated."
      : `Added ${keywordCoverageDelta} supported job-language signal${keywordCoverageDelta === 1 ? "" : "s"}; the audit-only ATS estimate increased without adding new candidate facts.`;
  }
  return { content, audit };
}
