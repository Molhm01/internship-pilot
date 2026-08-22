import path from "node:path";
import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { prisma } from "@/lib/db";
import { compileTypst, escapeTypstString, typstStringArray } from "@/lib/documents/typst";
import { extractPdfText } from "@/lib/pdf";
import { evaluateStrictDocumentQa } from "@/lib/documents/qa";
import { evaluatePdfLayoutQa, evaluateResumeFormatPreservation } from "@/lib/documents/layoutQa";
import { logAudit } from "@/lib/applications/audit";
import { validateDocumentIdentity } from "@/lib/documents/identityGuard";
import { selectContentForJob } from "@/lib/documents/select";
import {
  correctAndValidateResumeContent,
  factsExcludingUnsupportedMeanings,
  resumeClaimSources,
  validateUnsupportedClaims,
  type UnsupportedClaimDetail,
} from "@/lib/documents/claimValidation";
import { hasUsableJobDescription, matchJobDescriptionText } from "@/lib/matchWorkflow";
import { assertLocalRuntime } from "@/lib/runtime/deployment";
import { writeStoredObject } from "@/lib/storage";
import {
  deliverDocumentToAgent,
  tailoredFilename,
  type AgentDeliveryOutcome,
} from "@/lib/documents/agentDelivery";
import {
  MASTER_ACTIVITIES, MASTER_EDUCATION, MASTER_EXPERIENCE, MASTER_PROJECTS, MASTER_SKILLS,
  isSupportedTransferableRequirement, tailoredMasterContent,
  type EvidenceFact, type MasterEducation, type MasterEntry, type MasterSkillGroup,
} from "@/lib/documents/masterResume";

const GENERATED_DIR_REL = process.env.GENERATED_OUTPUT_DIR ?? "data/generated";
const TEMPLATE_IMPORT = "/templates";
const MASTER_RESUME_REFERENCE_REL = "templates/master_resume_reference.pdf";
/** The untailored master, used as the fallback when tailoring will not fit. */
const MASTER_CONTENT: ResumeContent = {
  education: MASTER_EDUCATION,
  experience: MASTER_EXPERIENCE,
  projects: MASTER_PROJECTS,
  skills: MASTER_SKILLS,
  activities: MASTER_ACTIVITIES,
};
function absolute(relativePath: string) { return path.isAbsolute(relativePath) ? relativePath : path.join(/* turbopackIgnore: true */ process.cwd(), relativePath); }
function s(value: string) { return `"${escapeTypstString(value)}"`; }
function dict(fields: Record<string, string>) { return `(${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join(", ")})`; }
function dictArray(items: Record<string, string>[]) { return `(${items.map(dict).join(", ")}${items.length === 1 ? "," : ""})`; }
function educationTypst(items: MasterEducation[]) {
  return dictArray(items.map((x) => ({ school: s(x.school), degree: s(x.degree), coursework: s(x.coursework), location: s(x.location), dates: s(x.dates) })));
}
function entriesTypst(items: MasterEntry[]) {
  return dictArray(items.map((x) => ({ title: s(x.title), organization: s(x.organization), location: s(x.location), dates: s(x.dates), bullets: typstStringArray(x.bullets) })));
}
function skillsTypst(items: MasterSkillGroup[]) {
  return dictArray(items.map((x) => ({ label: s(x.label), items: typstStringArray(x.items) })));
}

type HeaderProfile = { fullName: string; email: string; phone: string; linkedin?: string | null; workAuthorization?: string | null; addressCity?: string | null; addressState?: string | null };
export type ResumeContent = { education: MasterEducation[]; experience: MasterEntry[]; projects: MasterEntry[]; skills: MasterSkillGroup[]; activities: string[] };
export function buildMasterResumeSource(profile: HeaderProfile, content: ResumeContent = { education: MASTER_EDUCATION, experience: MASTER_EXPERIENCE, projects: MASTER_PROJECTS, skills: MASTER_SKILLS, activities: MASTER_ACTIVITIES }) {
  const contact = ["NYC Metro Area", profile.email, profile.phone, profile.linkedin, profile.workAuthorization]
    .filter((value): value is string => Boolean(value?.trim()));
  return `#import "${TEMPLATE_IMPORT}/resume-template.typ": resume\n#resume(name: ${s(profile.fullName)}, contact: ${typstStringArray(contact)}, education: ${educationTypst(content.education)}, experience: ${entriesTypst(content.experience)}, projects: ${entriesTypst(content.projects)}, skills: ${skillsTypst(content.skills)}, activities: ${typstStringArray(content.activities)})\n`;
}

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function takeWords(value: string, maximum: number): string {
  const items = words(value);
  const selected = items.length <= maximum ? value.trim() : `${items.slice(0, maximum).join(" ")}…`;
  // A literal compound-word hyphen is a legal wrap point in Typst. Use the
  // non-breaking form in cover-letter prose so QA does not archive an
  // otherwise sound PDF merely because "peak-hour" wrapped at the hyphen.
  return selected.replace(/(?<=\w)-(?=\w)/g, "‑");
}

function relevance(value: string, jobText: string): number {
  return normalizedTerms(value).reduce(
    (score, term) => score + (jobText.includes(term) ? 1 : 0),
    0,
  );
}

function normalizedTerms(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9+.#]+/).filter((term) => term.length > 2);
}

function factNarrative(fact: EvidenceFact): string {
  return `${fact.content}${fact.detail ? `. ${fact.detail}` : "."}`;
}

export function buildGroundedCoverLetterParagraphs(
  job: { title: string; company: string; description: string },
  approvedFacts: EvidenceFact[],
  selectedFactIds: string[] = [],
): string[] {
  const selected = new Set(selectedFactIds);
  const jobText = `${job.title} ${job.description}`.toLowerCase();
  const ranked = approvedFacts
    .filter((fact) => ["experience", "project", "education", "coursework", "skill", "activity"].includes(fact.type ?? ""))
    .map((fact, index) => ({
      fact,
      index,
      selected: selected.has(fact.id),
      score: relevance(factNarrative(fact), jobText),
    }))
    .sort((a, b) =>
      Number(b.selected) - Number(a.selected)
      || b.score - a.score
      || a.index - b.index,
    );
  const evidence = ranked.map(({ fact }) => factNarrative(fact)).join(" ");
  const evidenceWords = words(evidence).slice(0, 158);
  const midpoint = Math.ceil(evidenceWords.length / 2);
  const firstEvidence = evidenceWords.slice(0, midpoint).join(" ");
  const secondEvidence = evidenceWords.slice(midpoint).join(" ");

  return [
    `I am applying for the ${job.title} position at ${job.company}. The responsibilities and qualifications in the current posting are the basis for the evidence selected in this letter.`,
    `My approved candidate profile documents this work and education: ${takeWords(firstEvidence, 82)}`,
    `The same approved profile also records: ${takeWords(secondEvidence, 82)}`,
    `I would welcome the opportunity to discuss this role and the approved experience above. I would be direct about which qualifications are supported by my record and which ones I still need to learn.`,
  ];
}

function parseFactIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseMatchSkills(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((item) =>
        item && typeof item === "object" && typeof (item as { skill?: unknown }).skill === "string"
          ? [(item as { skill: string }).skill]
          : [],
      )
      : [];
  } catch {
    return [];
  }
}

function normalizedClaimText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function findUnsupportedClaims(text: string, unsupportedQualifications: string[]): string[] {
  const normalizedText = ` ${normalizedClaimText(text)} `;
  return unsupportedQualifications.filter((qualification) => {
    const normalizedQualification = normalizedClaimText(qualification);
    return normalizedQualification.length >= 2
      && normalizedText.includes(` ${normalizedQualification} `);
  });
}

export function approvedFactsExcludingUnsupportedClaims(
  facts: EvidenceFact[],
  unsupportedQualifications: string[],
): EvidenceFact[] {
  return factsExcludingUnsupportedMeanings(facts, unsupportedQualifications);
}

function unsupportedClaimPatterns(unsupportedQualifications: string[]): RegExp[] {
  return unsupportedQualifications.flatMap((qualification) => {
    const terms = qualification
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!terms.length) return [];
    return [new RegExp(`(?:^|\\s)${terms.join("\\s+")}(?=$|\\s|[.,;:!?()])`, "i")];
  });
}

export type DocumentGenerationStage =
  | "validation"
  | "job_load"
  | "profile_load"
  | "content_selection"
  | "resume_generation"
  | "resume_persistence"
  | "cover_letter_generation"
  | "cover_letter_persistence";

export class DocumentGenerationError extends Error {
  constructor(
    message: string,
    public readonly stage: DocumentGenerationStage = "validation",
    public readonly unsupportedClaims: UnsupportedClaimDetail[] = [],
  ) {
    super(message);
    this.name = "DocumentGenerationError";
  }
}
export type GeneratedDocSummary = { id: string; type: string; version: number; storagePath: string; qaStatus: string; qaIssues: string[] };

/**
 * Whether each generated file reached the local Internship Agent, which is what
 * the extension attaches from. Reported rather than thrown: a delivery failure
 * means "the agent is not running", not "your résumé is bad", and discarding a
 * QA-passing document over it would be worse than saying so plainly.
 */
export type AgentDeliverySummary = {
  resume: AgentDeliveryOutcome;
  coverLetter?: AgentDeliveryOutcome;
};

function progress(jobId: string, stage: string) {
  console.info(JSON.stringify({ event: "tailored-document-generation", jobId, stage }));
}

function stageFailure(stage: DocumentGenerationStage): string {
  const labels: Record<DocumentGenerationStage, string> = {
    validation: "Document validation",
    job_load: "Job loading",
    profile_load: "Candidate profile loading",
    content_selection: "Tailoring content selection",
    resume_generation: "Resume generation",
    resume_persistence: "Resume persistence",
    cover_letter_generation: "Cover letter generation",
    cover_letter_persistence: "Cover letter persistence",
  };
  return `${labels[stage]} failed. Existing document versions were kept.`;
}

function unsupportedClaimFailure(
  documentKind: "resume" | "cover letter",
  claims: UnsupportedClaimDetail[],
): DocumentGenerationError {
  const phrases = Array.from(new Set(claims.map((claim) => claim.phrase)));
  return new DocumentGenerationError(
    `Generation stopped because unsupported qualifications could not be safely removed from the ${documentKind}: ${phrases.join(", ")}.`,
    "validation",
    claims,
  );
}

/**
 * Generates the tailored résumé (and optionally cover letter) for one job.
 *
 * `userId` is required. Everything this reads is that person's — their
 * approved facts, their bullet library, their identity — and everything it
 * writes belongs to them: the `GeneratedDocument` rows carry the owner, and the
 * files are written under `users/<userId>/`.
 */
export async function generateDocumentsForJob(
  jobId: string,
  userId: string,
  options: { includeCoverLetter?: boolean } = {},
) {
  // Typst is a native binary invoked with child_process, and it reads and
  // writes real files under the repository root. Neither exists on a
  // serverless host, so this is stated up front rather than discovered as a
  // spawn ENOENT halfway through a two-minute generation.
  assertLocalRuntime("typst");
  let currentStage: DocumentGenerationStage = "job_load";
  try {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { matchResults: { where: { userId }, orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!job) throw new DocumentGenerationError("Job not found.");
  progress(jobId, "job_loaded");
  if (!hasUsableJobDescription(job)) {
    throw new DocumentGenerationError("A usable job description is required before tailored documents can be generated.");
  }
  const description = matchJobDescriptionText(job);
  const generationJob = { ...job, description };
  const latestMatch = job.matchResults[0];
  if (!latestMatch) throw new DocumentGenerationError("Run AI Match before generating tailored documents.");
  if (latestMatch.eligibility === "Fail") throw new DocumentGenerationError("Eligibility is Fail for this job — documents are not generated.");
  currentStage = "profile_load";
  const profile = await applicationProfileForUser(userId);
  if (!profile?.fullName?.trim()) throw new DocumentGenerationError("Add your full name on the Documents page before generating documents.");
  if (!profile.email?.trim() || !profile.phone?.trim()) throw new DocumentGenerationError("Add both email and telephone to the Candidate Profile before generating documents.");
  // Held as their own constants: property narrowing does not survive into a
  // closure, and the résumé is compiled inside one below.
  const candidateName: string = profile.fullName;
  const candidateEmail: string = profile.email;
  const candidatePhone: string = profile.phone;
  progress(jobId, "profile_loaded");

  currentStage = "content_selection";
  // User-separated. Two applicants tailoring a résumé for the same posting
  // wrote into one folder before this, and on blob storage a leaked URL was a
  // permanent, unauthenticated read of somebody else's résumé.
  const jobDirRel = `${GENERATED_DIR_REL}/users/${userId}/jobs/${jobId}`;
  await mkdir(absolute(jobDirRel), { recursive: true });
  const facts = await prisma.resumeFact.findMany({
    where: { userId, status: { in: ["approved", "edited"] } },
  });
  if (!facts.length) {
    throw new DocumentGenerationError("No approved profile facts are available for document generation.");
  }
  const validFactIds = new Set(facts.map((fact) => fact.id));
  // Scoped like the facts above. The fact-id filter below happened to reject
  // another account's bullets, but that is an accident of cuid uniqueness
  // rather than an ownership check — this résumé is built only from rows this
  // user owns.
  const bullets = (await prisma.resumeBullet.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }))
    .filter((bullet) => {
      const factIds = parseFactIds(bullet.factIds);
      return factIds.length > 0 && factIds.every((factId) => validFactIds.has(factId));
    });
  let selectedBulletIds: string[] = [];
  if (bullets.length) {
    try {
      const selection = await selectContentForJob(generationJob, bullets, facts);
      selectedBulletIds = [
        ...selection.experienceBulletIds,
        ...selection.projectBulletIds,
        ...selection.activityBulletIds,
      ];
    } catch (error) {
      console.warn(JSON.stringify({
        event: "tailored-document-generation",
        jobId,
        stage: "content_selection_fallback",
        reason: error instanceof Error ? error.name : "unknown",
      }));
      // Keep generation available if the selector model is unavailable. The
      // deterministic fallback still uses the current description and only
      // existing fact-linked bullet IDs.
      const jobText = `${job.title} ${description}`.toLowerCase();
      selectedBulletIds = bullets
        .map((bullet, index) => ({
          id: bullet.id,
          index,
          score: relevance(bullet.text, jobText),
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 6)
        .map((item) => item.id);
    }
  }
  const selectedIdSet = new Set(selectedBulletIds);
  const selectedFactIds = Array.from(new Set(
    bullets
      .filter((bullet) => selectedIdSet.has(bullet.id))
      .flatMap((bullet) => parseFactIds(bullet.factIds)),
  ));
  const originallySupported = parseMatchSkills(latestMatch.skillsSupported);
  const rawConfirmationRequired = parseMatchSkills(latestMatch.skillsNeedConfirmation);
  const rawDevelopmentGaps = parseMatchSkills(latestMatch.skillsToLearn);
  const rawNeverClaim = parseMatchSkills(latestMatch.skillsNeverAdd);
  const reclassifiedTransferableCompetencies = Array.from(new Set([
    ...rawConfirmationRequired,
    ...rawDevelopmentGaps,
    ...rawNeverClaim,
  ].filter(isSupportedTransferableRequirement)));
  const supportedKeywords = Array.from(new Set([
    ...originallySupported,
    ...reclassifiedTransferableCompetencies,
  ]));
  const confirmationRequired = rawConfirmationRequired.filter((item) =>
    !isSupportedTransferableRequirement(item),
  );
  const developmentGaps = rawDevelopmentGaps.filter((item) =>
    !isSupportedTransferableRequirement(item),
  );
  const neverClaim = rawNeverClaim.filter((item) =>
    !isSupportedTransferableRequirement(item),
  );
  const unsupportedQualifications = Array.from(new Set([
    ...confirmationRequired,
    ...developmentGaps,
    ...neverClaim,
  ]));
  const documentFacts = approvedFactsExcludingUnsupportedClaims(facts, unsupportedQualifications);
  if (!documentFacts.length) {
    throw new DocumentGenerationError("No approved profile facts remain after excluding unsupported AI Match claims.");
  }
  const tailoring = tailoredMasterContent(generationJob, documentFacts, latestMatch.score, {
    selectedFactIds,
    unsupportedQualifications,
    supportedRequirements: supportedKeywords,
  });
  const correction = correctAndValidateResumeContent(
    tailoring.content,
    unsupportedQualifications,
    documentFacts,
  );
  if (correction.unsupportedClaims.length) {
    throw unsupportedClaimFailure("resume", correction.unsupportedClaims);
  }
  tailoring.content = correction.content;
  if (correction.correctedClaims.length) {
    tailoring.audit.unsupportedWordingRemoved = correction.correctedClaims.map((claim) => ({
      phrase: claim.phrase,
      sourceSection: claim.sourceSection,
      reason: claim.reason,
    }));
  }
  const supportedKeywordCandidates = Array.from(new Set([
    ...supportedKeywords,
    ...tailoring.audit.supportedKeywords.map((item) => item.keyword),
    ...tailoring.audit.keywordsAdded,
  ]));
  const keywordClassificationFor = (source: string) => ({
    supported: supportedKeywordCandidates.filter((keyword) =>
      findUnsupportedClaims(source, [keyword]).length > 0,
    ),
    confirmationRequired,
    developmentGap: developmentGaps,
    unsupported: neverClaim,
  });
  const header = { fullName: profile.fullName, email: profile.email, phone: profile.phone, linkedin: profile.linkedin, workAuthorization: profile.workAuthorization, addressCity: profile.addressCity, addressState: profile.addressState };
  currentStage = "resume_generation";
  // Per user. Counting every account's documents for this job made one
  // applicant's version numbers depend on how many other people had applied,
  // and leaked that count into their own filenames.
  const resumeVersion = await prisma.generatedDocument.count({ where: { userId, jobId, type: "resume" } }) + 1;
  const resumeSourceRel = `${jobDirRel}/resume-v${resumeVersion}.typ`;
  const resumePdfRel = `${jobDirRel}/resume-v${resumeVersion}.pdf`;
  const unsupportedResumeClaims = validateUnsupportedClaims(
    resumeClaimSources(tailoring.content),
    unsupportedQualifications,
    documentFacts,
  );
  if (unsupportedResumeClaims.length) {
    throw unsupportedClaimFailure("resume", unsupportedResumeClaims);
  }
  const referenceResumeBytes = new Uint8Array(await readFile(absolute(MASTER_RESUME_REFERENCE_REL)));

  /** Compile one candidate résumé and run every check that applies to it. */
  const compileAndCheck = async (content: ResumeContent) => {
    const source = buildMasterResumeSource(header, content);
    await writeFile(absolute(resumeSourceRel), source, "utf-8");
    const compile = await compileTypst(absolute(resumeSourceRel), absolute(resumePdfRel), absolute(""));
    if (!compile.ok) throw new DocumentGenerationError(`Resume compilation failed: ${compile.stderr}`);
    const bytes = new Uint8Array(await readFile(absolute(resumePdfRel)));
    const layoutBytes = bytes.slice();
    const extraction = await extractPdfText(bytes);
    const strict = evaluateStrictDocumentQa(
      extraction.text,
      ["EDUCATION", "EXPERIENCE", "PROJECTS", "SKILLS", "ACTIVITIES & LEADERSHIP"],
      [
        ...content.education.flatMap((item) => [item.school, item.degree, item.coursework, item.location, item.dates]),
        ...content.experience.flatMap((item) => [item.title, item.organization, item.location, item.dates, ...item.bullets]),
        ...content.projects.flatMap((item) => [item.title, item.organization, item.location, item.dates, ...item.bullets]),
        ...content.skills.flatMap((group) => group.items),
        ...content.activities,
      ].filter(Boolean),
      { kind: "resume", candidateName, contactValues: [candidateEmail, candidatePhone], requiredHeadings: ["EDUCATION", "EXPERIENCE", "PROJECTS", "SKILLS", "ACTIVITIES & LEADERSHIP"], requiredProjectTitles: content.projects.map((x) => x.title), pageCount: extraction.pageCount, forbiddenText: [/\b(?:TBD|TODO|PLACEHOLDER)\b/i, /Expected\s+Expected/i, ...unsupportedClaimPatterns(unsupportedQualifications)] },
    );
    // Kept apart so the fallback below can tell "this résumé says the wrong
    // things" from "this résumé does not fit on the page". Collected into a
    // fresh list rather than pushed onto the object the checker returned: this
    // runs twice, and mutating a returned value carries the first attempt's
    // verdict into the second.
    const contentIssues = [...strict.issues];
    const identityIssues = validateDocumentIdentity(extraction.text, profile);
    const layout = await evaluatePdfLayoutQa(layoutBytes, "resume");
    const format = await evaluateResumeFormatPreservation(layoutBytes, referenceResumeBytes);
    const layoutIssues = [...layout.issues, ...format.issues];
    const qa = { status: strict.status, issues: [...contentIssues, ...identityIssues, ...layoutIssues] };
    return { source, bytes, layoutBytes, extraction, qa, identityIssues, contentIssues, layoutIssues, format, keywordClassification: keywordClassificationFor(source) };
  };

  let attempt = await compileAndCheck(tailoring.content);
  let storedTailoringStatus: string = tailoring.audit.status;

  /**
   * A tailored résumé that runs onto a second page is not usable, and neither
   * is no résumé at all.
   *
   * The master fills its one page with almost no slack, so the substitutions
   * tailoring makes — a longer verb, an added keyword — can push it over. When
   * that happens the honest answer is the untailored master: every claim in it
   * is the applicant's own and already approved, and the format rule is the one
   * thing standing between a résumé and an employer who will not read a
   * two-page intern résumé. Failing generation outright left the applicant with
   * nothing to apply with, which is strictly worse.
   *
   * Only a formatting failure is recoverable this way. An identity mismatch or
   * an unsupported claim means the *content* is wrong, and recompiling the same
   * facts would not fix it.
   */
  const onlyFormattingFailed =
    attempt.layoutIssues.length > 0
    && attempt.contentIssues.length === 0
    && attempt.identityIssues.length === 0;
  const tailoringChangedSomething =
    tailoring.audit.bulletsChanged.length > 0
    || tailoring.audit.bulletsReordered.length > 0
    || tailoring.audit.keywordsAdded.length > 0;
  if (onlyFormattingFailed && tailoringChangedSomething) {
    const masterAttempt = await compileAndCheck(MASTER_CONTENT);
    if (masterAttempt.qa.issues.length === 0) {
      console.warn(JSON.stringify({
        event: "tailored-document-generation",
        stage: "tailoring_exceeded_master_format",
        jobId,
        issues: attempt.qa.issues,
      }));
      tailoring.audit.status = "MASTER_UNCHANGED_NO_SUPPORTED_IMPROVEMENT";
      tailoring.audit.keywordsAdded = [];
      tailoring.audit.bulletsChanged = [];
      tailoring.audit.bulletsReordered = [];
      tailoring.content = MASTER_CONTENT;
      storedTailoringStatus = "MASTER_RESUME_FALLBACK";
      attempt = masterAttempt;
    }
  }

  const resumeBytes = attempt.bytes;
  const resumeQa = attempt.qa;
  const resumeIdentityIssues = attempt.identityIssues;
  const formatQa = attempt.format;
  const resumeKeywordClassification = attempt.keywordClassification;
  tailoring.audit.formattingPreservation = {
    status: formatQa.status,
    method: "Compiled through the fixed master Typst template, then compared with templates/master_resume_reference.pdf for page size, margins, fonts, font sizes, date alignment, bullet indentation, activity rows, and line spacing.",
    issues: formatQa.issues,
  };
  if (resumeQa.issues.length && !resumeIdentityIssues.length) resumeQa.status = "fail";
  const resumeQaStatus = resumeIdentityIssues.length ? "INVALID_TEST_DATA" : resumeQa.status;
  progress(jobId, "resume_generated");
  currentStage = "resume_persistence";
  // The compiled PDF is handed to the storage abstraction and the identifier
  // it returns is what the row keeps. Locally that is the same relative path
  // Typst just wrote; with object storage configured it is a durable URL, and
  // the download route resolves either without knowing which it received.
  const resumeStorageKey = await writeStoredObject(resumePdfRel, resumeBytes, { contentType: "application/pdf" });
  const resumeDoc = await prisma.generatedDocument.create({ data: { userId, jobId, type: "resume", version: resumeVersion, storagePath: resumeStorageKey, typstSourcePath: resumeSourceRel, qaStatus: resumeQaStatus, qaIssues: JSON.stringify(resumeQa.issues), keywordClassification: JSON.stringify(resumeKeywordClassification), tailoringStatus: storedTailoringStatus, tailoringAudit: JSON.stringify(tailoring.audit), identityVerified: resumeIdentityIssues.length === 0, bulletIdsUsed: JSON.stringify(selectedBulletIds), matchResultId: latestMatch?.id ?? null } });
  const result: { resume: GeneratedDocSummary; coverLetter?: GeneratedDocSummary; agentDelivery?: AgentDeliverySummary } = { resume: { id: resumeDoc.id, type: "resume", version: resumeVersion, storagePath: resumeStorageKey, qaStatus: resumeQaStatus, qaIssues: resumeQa.issues } };
  if (resumeQaStatus !== "pass") {
    throw new DocumentGenerationError(`Resume generation failed QA: ${resumeQa.issues.join(" ")}`);
  }

  // Handed to the agent only after it has passed QA, and awaited: the caller
  // must not be told the résumé is ready for autofill until the agent has
  // acknowledged holding those exact bytes.
  const resumeDelivery = await deliverDocumentToAgent({
    documentType: "resume",
    filename: tailoredFilename("resume", job.company, job.title),
    bytes: resumeBytes,
    source: "tailored",
    company: job.company,
    jobTitle: job.title,
    jobId,
    createdAt: resumeDoc.createdAt.toISOString(),
  });
  result.agentDelivery = { resume: resumeDelivery };

  if (options.includeCoverLetter !== false) {
    currentStage = "cover_letter_generation";
    const paragraphs = buildGroundedCoverLetterParagraphs(generationJob, documentFacts, selectedFactIds);
    const coverVersion = await prisma.generatedDocument.count({ where: { userId, jobId, type: "coverLetter" } }) + 1;
    const coverSourceRel = `${jobDirRel}/cover-letter-v${coverVersion}.typ`;
    const coverPdfRel = `${jobDirRel}/cover-letter-v${coverVersion}.pdf`;
    const savedLocation = [profile.addressCity, profile.addressState]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(", ");
    const contact = [savedLocation, profile.phone, profile.email, profile.linkedin].filter((value): value is string => !!value?.trim());
    const date = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" }).format(new Date());
    const coverSource = `#import "${TEMPLATE_IMPORT}/cover-letter-template.typ": coverLetter\n#coverLetter(name: ${s(profile.fullName)}, location: "", contact: ${typstStringArray(contact)}, date: ${s(date)}, company: ${s(job.company)}, jobTitle: ${s(job.title)}, paragraphs: ${typstStringArray(paragraphs)})\n`;
    const unsupportedCoverClaims = validateUnsupportedClaims(
      paragraphs.map((text, index) => ({
        sourceSection: `Cover letter paragraph ${index + 1}`,
        text,
        context: index === 1 || index === 2 ? "candidate" : "ordinary",
      })),
      unsupportedQualifications,
      documentFacts,
    );
    if (unsupportedCoverClaims.length) {
      throw unsupportedClaimFailure("cover letter", unsupportedCoverClaims);
    }
    const coverKeywordClassification = keywordClassificationFor(coverSource);
    await writeFile(absolute(coverSourceRel), coverSource, "utf-8");
    const coverCompile = await compileTypst(absolute(coverSourceRel), absolute(coverPdfRel), absolute(""));
    if (!coverCompile.ok) throw new DocumentGenerationError(`Cover letter compilation failed: ${coverCompile.stderr}`);
    const coverBytes = new Uint8Array(await readFile(absolute(coverPdfRel)));
    const coverLayoutBytes = coverBytes.slice();
    const coverExtraction = await extractPdfText(coverBytes);
    const coverQa = evaluateStrictDocumentQa(coverExtraction.text, [], [job.company, profile.fullName, ...paragraphs], { kind: "coverLetter", candidateName: profile.fullName, contactValues: [profile.email ?? "", profile.phone ?? ""], pageCount: coverExtraction.pageCount, wordCount: paragraphs.join(" ").split(/\s+/).filter(Boolean).length, forbiddenText: [/\b(?:TBD|TODO|PLACEHOLDER)\b/i, /I am eager to contribute/i, /I am particularly drawn to/i, /I am passionate about/i, /skills align perfectly/i] });
    const coverIdentityIssues = validateDocumentIdentity(coverExtraction.text, profile);
    coverQa.issues.push(...coverIdentityIssues);
    const titleOccurrences = coverExtraction.text.split(job.title).length - 1;
    if (titleOccurrences !== 1) coverQa.issues.push(`Complete job title must appear exactly once; found ${titleOccurrences}.`);
    const coverLayoutQa = await evaluatePdfLayoutQa(coverLayoutBytes, "coverLetter");
    coverQa.issues.push(...coverLayoutQa.issues);
    if (coverQa.issues.length && !coverIdentityIssues.length) coverQa.status = "fail";
    const coverQaStatus = coverIdentityIssues.length ? "INVALID_TEST_DATA" : coverQa.status;
    progress(jobId, "cover_letter_generated");
    currentStage = "cover_letter_persistence";
    const coverStorageKey = await writeStoredObject(coverPdfRel, coverBytes, { contentType: "application/pdf" });
    const coverDoc = await prisma.generatedDocument.create({ data: { userId, jobId, type: "coverLetter", version: coverVersion, storagePath: coverStorageKey, typstSourcePath: coverSourceRel, qaStatus: coverQaStatus, qaIssues: JSON.stringify(coverQa.issues), keywordClassification: JSON.stringify(coverKeywordClassification), tailoringStatus: storedTailoringStatus, tailoringAudit: JSON.stringify(tailoring.audit), identityVerified: coverIdentityIssues.length === 0, bulletIdsUsed: JSON.stringify(selectedBulletIds), matchResultId: latestMatch?.id ?? null } });
    result.coverLetter = { id: coverDoc.id, type: "coverLetter", version: coverVersion, storagePath: coverStorageKey, qaStatus: coverQaStatus, qaIssues: coverQa.issues };
    if (coverQaStatus !== "pass") {
      throw new DocumentGenerationError(`Cover letter generation failed QA: ${coverQa.issues.join(" ")}`);
    }
    const coverDelivery = await deliverDocumentToAgent({
      documentType: "cover_letter",
      filename: tailoredFilename("cover_letter", job.company, job.title),
      bytes: coverBytes,
      source: "tailored",
      company: job.company,
      jobTitle: job.title,
      jobId,
      createdAt: coverDoc.createdAt.toISOString(),
    });
    result.agentDelivery = { resume: resumeDelivery, coverLetter: coverDelivery };
  }
  progress(jobId, "pdfs_persisted");
  try {
    await logAudit({ jobId, actor: "document-generation", action: "documents-generated", detail: `Generated a master-preserving resume (QA: ${result.resume.qaStatus})${result.coverLetter ? ` and grounded cover letter (QA: ${result.coverLetter.qaStatus})` : ""}.`, metadata: { resumeVersion } });
  } catch (error) {
    console.error("Document generation completed, but the audit log write failed.", { jobId, error });
  }
  return result;
  } catch (error) {
    if (error instanceof DocumentGenerationError) throw error;
    // The reader gets a stage, not a stack trace — but the stage alone is not
    // enough to fix anything, and this used to discard the cause entirely. It
    // is logged for the server and carried as `cause` for anything that wants
    // it, while the message the user sees stays the same.
    console.error(JSON.stringify({
      event: "tailored-document-generation",
      stage: currentStage,
      jobId,
      reason: error instanceof Error ? error.message : String(error),
    }));
    throw Object.assign(
      new DocumentGenerationError(stageFailure(currentStage), currentStage),
      { cause: error },
    );
  }
}
