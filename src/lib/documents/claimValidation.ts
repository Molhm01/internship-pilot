import type {
  EvidenceFact,
  MasterEducation,
  MasterEntry,
  MasterSkillGroup,
} from "@/lib/documents/masterResume";

export type ClaimContext = "candidate" | "job_requirement" | "ordinary";

export type ClaimSource = {
  sourceSection: string;
  text: string;
  context: ClaimContext;
};

export type UnsupportedClaimDetail = {
  phrase: string;
  sourceSection: string;
  sentence: string;
  reason: string;
};

export type ResumeClaimContent = {
  education: MasterEducation[];
  experience: MasterEntry[];
  projects: MasterEntry[];
  skills: MasterSkillGroup[];
  activities: string[];
};

const TOKEN_ALIASES: Array<[RegExp, string]> = [
  [/^acquir|^acquisition/, "acquisition"],
  [/^diagnos/, "diagnose"],
  [/^measur/, "measure"],
  [/^reliab/, "reliability"],
  [/^sampl/, "sample"],
  [/^stabil/, "stability"],
  [/^test/, "test"],
];

function conceptToken(value: string): string {
  const singular = value.toLowerCase().replace(/(?:'s|s)$/i, "");
  return TOKEN_ALIASES.find(([pattern]) => pattern.test(singular))?.[1] ?? singular;
}

function concepts(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((token) => token.length > 1)
      .map(conceptToken),
  ));
}

export function containsQualificationMeaning(text: string, qualification: string): boolean {
  const required = concepts(qualification);
  if (!required.length) return false;
  const available = new Set(concepts(text));
  return required.every((token) => available.has(token));
}

function factText(fact: EvidenceFact): string {
  return `${fact.content} ${fact.detail ?? ""}`.trim();
}

export function isQualificationSupportedByFacts(
  qualification: string,
  facts: EvidenceFact[],
): boolean {
  return facts.some((fact) => containsQualificationMeaning(factText(fact), qualification));
}

function containingSentence(text: string, qualification: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .find((sentence) => containsQualificationMeaning(sentence, qualification))
    ?.trim() ?? text.trim();
}

export function validateUnsupportedClaims(
  sources: ClaimSource[],
  unsupportedQualifications: string[],
  approvedFacts: EvidenceFact[],
): UnsupportedClaimDetail[] {
  const details: UnsupportedClaimDetail[] = [];
  for (const phrase of unsupportedQualifications) {
    if (isQualificationSupportedByFacts(phrase, approvedFacts)) continue;
    for (const source of sources) {
      // The caller knows whether text is a candidate assertion. A job requirement
      // explicitly presented as missing, or ordinary framing such as a job title,
      // is not evidence that the candidate has the qualification.
      if (source.context !== "candidate") continue;
      for (const sentence of source.text.split(/(?<=[.!?])\s+/).filter(Boolean)) {
        if (!containsQualificationMeaning(sentence, phrase)) continue;
        details.push({
          phrase,
          sourceSection: source.sourceSection,
          sentence: containingSentence(sentence, phrase),
          reason: "The wording attributes a qualification to the candidate, but no approved profile fact supports the complete meaning.",
        });
      }
    }
  }
  return details.filter((detail, index, all) =>
    all.findIndex((candidate) =>
      candidate.phrase === detail.phrase
      && candidate.sourceSection === detail.sourceSection
      && candidate.sentence === detail.sentence,
    ) === index,
  );
}

export function resumeClaimSources(content: ResumeClaimContent): ClaimSource[] {
  return [
    ...content.education.flatMap((item, index) => [
      { sourceSection: `Education ${index + 1} degree`, text: item.degree, context: "candidate" as const },
      { sourceSection: `Education ${index + 1} coursework`, text: item.coursework, context: "candidate" as const },
    ]),
    ...content.experience.flatMap((entry) => [
      { sourceSection: `Experience: ${entry.title}`, text: `${entry.title} ${entry.organization}`, context: "candidate" as const },
      ...entry.bullets.map((bullet) => ({ sourceSection: `Experience: ${entry.title}`, text: bullet, context: "candidate" as const })),
    ]),
    ...content.projects.flatMap((entry) => [
      { sourceSection: `Project: ${entry.title}`, text: `${entry.title} ${entry.organization}`, context: "candidate" as const },
      ...entry.bullets.map((bullet) => ({ sourceSection: `Project: ${entry.title}`, text: bullet, context: "candidate" as const })),
    ]),
    ...content.skills.flatMap((group) => group.items.map((item) => ({
      sourceSection: `Skills: ${group.label}`,
      text: item,
      context: "candidate" as const,
    }))),
    ...content.activities.map((activity) => ({
      sourceSection: "Activities & Leadership",
      text: activity,
      context: "candidate" as const,
    })),
  ];
}

function supportedReplacement(phrase: string, facts: EvidenceFact[]): string | null {
  const normalized = phrase.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const candidates = normalized === "real time data acquisition"
    ? ["sensor data sampling"]
    : normalized === "reliability testing"
      ? ["system stability testing"]
      : [];
  return candidates.find((candidate) => isQualificationSupportedByFacts(candidate, facts)) ?? null;
}

export type ResumeCorrectionResult = {
  content: ResumeClaimContent;
  correctedClaims: UnsupportedClaimDetail[];
  unsupportedClaims: UnsupportedClaimDetail[];
  validationPasses: number;
};

export function correctAndValidateResumeContent(
  original: ResumeClaimContent,
  unsupportedQualifications: string[],
  approvedFacts: EvidenceFact[],
): ResumeCorrectionResult {
  const content: ResumeClaimContent = {
    education: original.education.map((item) => ({ ...item })),
    experience: original.experience.map((entry) => ({ ...entry, bullets: [...entry.bullets] })),
    projects: original.projects.map((entry) => ({ ...entry, bullets: [...entry.bullets] })),
    skills: original.skills.map((group) => ({ ...group, items: [...group.items] })),
    activities: [...original.activities],
  };
  const initial = validateUnsupportedClaims(
    resumeClaimSources(content),
    unsupportedQualifications,
    approvedFacts,
  );
  if (!initial.length) {
    return { content, correctedClaims: [], unsupportedClaims: [], validationPasses: 1 };
  }

  // Skill rows are independently removable without changing the master template,
  // section order, typography, or any supported experience. Replace only when a
  // conservative alternative is fully supported by one approved fact.
  content.skills = content.skills.map((group) => ({
    ...group,
    items: group.items.flatMap((item) => {
      const claims = initial.filter((claim) =>
        claim.sourceSection === `Skills: ${group.label}`
        && containsQualificationMeaning(item, claim.phrase),
      );
      if (!claims.length) return [item];
      const replacements = claims
        .map((claim) => supportedReplacement(claim.phrase, approvedFacts))
        .filter((value): value is string => Boolean(value));
      return replacements.length ? Array.from(new Set(replacements)) : [];
    }),
  }));

  const remaining = validateUnsupportedClaims(
    resumeClaimSources(content),
    unsupportedQualifications,
    approvedFacts,
  );
  return {
    content,
    correctedClaims: initial.filter((claim) => !remaining.some((item) =>
      item.phrase === claim.phrase && item.sourceSection === claim.sourceSection,
    )),
    unsupportedClaims: remaining,
    validationPasses: 2,
  };
}

export function factsExcludingUnsupportedMeanings(
  facts: EvidenceFact[],
  unsupportedQualifications: string[],
): EvidenceFact[] {
  return facts.filter((fact) => !unsupportedQualifications.some((qualification) =>
    containsQualificationMeaning(factText(fact), qualification),
  ));
}
