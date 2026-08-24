import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { classifyDisciplines } from "@/lib/sync/classify";
import {
  fingerprintApprovedFacts,
  type FingerprintFact,
} from "@/lib/matching/profileFingerprint";

export const BASELINE_SCORE_SOURCE = "BASELINE";
export const AI_REFINED_SCORE_SOURCE = "AI_REFINED";
export const BASELINE_RUBRIC_VERSION = "baseline-v1";
export const BASELINE_BACKFILL_BATCH_SIZE = 100;

export type BaselineProfile = {
  userId: string;
  revision: string;
  facts: FingerprintFact[];
};

export type BaselineJobInput = {
  id?: string;
  title: string;
  company: string;
  location?: string | null;
  workplaceType?: string | null;
  internshipTerm?: string | null;
  description?: string | null;
  jobResponsibilities?: string | null;
  jobQualifications?: string | null;
  disciplineTags?: string | null;
  sophomoreEligible?: boolean | null;
  graduationYears?: string | null;
  sponsorship?: string | null;
  citizenshipOrClearance?: boolean | null;
  season?: string | null;
};

export type BaselineAdjustment = {
  category: string;
  points: number;
  evidence: string;
};

export type BaselineScore = {
  score: number;
  eligibilityStatus: "Pass" | "Fail" | "Unknown";
  scoreSource: typeof BASELINE_SCORE_SOURCE;
  profileRevision: string;
  jobFingerprint: string;
  explanation: string;
};

const STOP_WORDS = new Set([
  "and", "are", "for", "from", "intern", "internship", "job", "role", "the", "this", "with",
  "student", "engineering", "engineer", "work", "team", "will", "your", "you", "our", "who",
]);

// Closed, auditable vocabulary: matching a token only proves that the approved
// evidence contains the same named technology. It never infers adjacent skills.
const TECHNICAL_SKILLS = [
  "python", "java", "javascript", "typescript", "c++", "c#", "matlab", "simulink", "sql", "r",
  "react", "next.js", "node.js", "aws", "azure", "gcp", "docker", "kubernetes", "git", "linux",
  "verilog", "systemverilog", "vhdl", "fpga", "cad", "solidworks", "autocad", "revit", "ansys",
  "labview", "altium", "arduino", "raspberry pi", "embedded", "firmware", "robotics", "controls",
  "plc", "power bi", "tableau", "excel", "tensorflow", "pytorch", "machine learning", "data science",
] as const;

const DEGREE_TERMS = [
  "computer science", "computer engineering", "electrical engineering", "mechanical engineering",
  "civil engineering", "chemical engineering", "biomedical engineering", "industrial engineering",
  "aerospace engineering", "materials engineering", "software engineering", "engineering technology",
] as const;

function normalized(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: string | null | undefined): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map(Number).filter(Number.isInteger)
      : [];
  } catch {
    return [];
  }
}

function factCorpus(profile: BaselineProfile): string {
  return normalized(profile.facts.map((fact) => `${fact.type} ${fact.content} ${fact.detail ?? ""}`).join("\n"));
}

function jobCorpus(job: BaselineJobInput): string {
  return normalized([
    job.title,
    job.company,
    job.location,
    job.workplaceType,
    job.internshipTerm,
    job.description,
    job.jobResponsibilities,
    job.jobQualifications,
    job.season,
  ].filter(Boolean).join("\n"));
}

function containsTerm(corpus: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(corpus);
}

function relevantTitleTokens(title: string): string[] {
  return Array.from(new Set(normalized(title).split(/[^a-z0-9+#.]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))));
}

function graduationYearFromFacts(profile: BaselineProfile): number | null {
  const graduationFacts = profile.facts.filter((fact) => fact.type === "graduationDate");
  for (const fact of graduationFacts) {
    const years = `${fact.content} ${fact.detail ?? ""}`.match(/\b20\d{2}\b/g) ?? [];
    if (years.length > 0) return Number(years[years.length - 1]);
  }
  return null;
}

function canonicalJobScoringInput(job: BaselineJobInput) {
  return {
    title: normalized(job.title),
    company: normalized(job.company),
    location: normalized(job.location),
    workplaceType: normalized(job.workplaceType),
    internshipTerm: normalized(job.internshipTerm),
    description: normalized(job.description),
    responsibilities: normalized(job.jobResponsibilities),
    qualifications: normalized(job.jobQualifications),
    disciplineTags: [...parseStringArray(job.disciplineTags)].sort(),
    sophomoreEligible: job.sophomoreEligible ?? null,
    graduationYears: [...parseNumberArray(job.graduationYears)].sort((a, b) => a - b),
    sponsorship: normalized(job.sponsorship),
    citizenshipOrClearance: job.citizenshipOrClearance ?? null,
    season: normalized(job.season),
  };
}

/** Fingerprint every job field that can influence either baseline or AI score. */
export function fingerprintJobScoringInput(job: BaselineJobInput): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJobScoringInput(job)))
    .digest("hex");
}

/**
 * Deterministic evidence-only rubric.
 *
 * Missing categories contribute zero points: 50 is the explicit neutral base,
 * not a claim that the candidate satisfies an unknown requirement. Positive or
 * negative adjustments are made only when both sides provide relevant facts.
 */
export function calculateBaselineScore(
  profile: BaselineProfile,
  job: BaselineJobInput,
): BaselineScore {
  const candidate = factCorpus(profile);
  const posting = jobCorpus(job);
  const adjustments: BaselineAdjustment[] = [];
  const missingEvidence: string[] = [];
  const hardFailures: string[] = [];

  const jobDisciplines = parseStringArray(job.disciplineTags);
  const inferredJobDisciplines = jobDisciplines.length > 0
    ? jobDisciplines
    : classifyDisciplines(job.title, posting);
  const candidateDisciplines = classifyDisciplines("", candidate);
  if (inferredJobDisciplines.length > 0 && candidateDisciplines.length > 0) {
    const candidateDisciplineSet = new Set<string>(candidateDisciplines);
    const overlap = inferredJobDisciplines.filter((tag) => candidateDisciplineSet.has(tag));
    adjustments.push({
      category: "discipline",
      points: overlap.length > 0 ? 14 : -8,
      evidence: overlap.length > 0
        ? `Approved evidence overlaps ${overlap.join(", ")}.`
        : "Approved evidence and posting discipline tags do not overlap.",
    });
  } else {
    missingEvidence.push("discipline");
  }

  const titleTokens = relevantTitleTokens(job.title);
  const titleMatches = titleTokens.filter((token) => containsTerm(candidate, token));
  if (titleTokens.length > 0) {
    const ratio = titleMatches.length / titleTokens.length;
    const points = ratio >= 0.5 ? 10 : ratio > 0 ? 5 : 0;
    if (points !== 0) {
      adjustments.push({ category: "role-title", points, evidence: `Approved evidence matches ${titleMatches.join(", ")}.` });
    } else {
      missingEvidence.push("role-title");
    }
  }

  const requiredSkills = TECHNICAL_SKILLS.filter((skill) => containsTerm(posting, skill));
  if (requiredSkills.length > 0) {
    const supported = requiredSkills.filter((skill) => containsTerm(candidate, skill));
    const ratio = supported.length / requiredSkills.length;
    const points = Math.round(-10 + ratio * 28);
    adjustments.push({
      category: "technical-skills",
      points,
      evidence: `${supported.length}/${requiredSkills.length} explicitly named technologies appear in approved evidence.`,
    });
  } else {
    missingEvidence.push("technical-skills");
  }

  const allowedGraduationYears = parseNumberArray(job.graduationYears);
  const candidateGraduationYear = graduationYearFromFacts(profile);
  if (allowedGraduationYears.length > 0 && candidateGraduationYear !== null) {
    const eligible = allowedGraduationYears.includes(candidateGraduationYear);
    adjustments.push({
      category: "graduation-year",
      points: eligible ? 10 : -22,
      evidence: eligible
        ? `Approved graduation year ${candidateGraduationYear} is listed as eligible.`
        : `Approved graduation year ${candidateGraduationYear} is not among ${allowedGraduationYears.join(", ")}.`,
    });
    if (!eligible) hardFailures.push("graduation-year");
  } else {
    missingEvidence.push("graduation-year");
  }

  if (job.sophomoreEligible !== null && job.sophomoreEligible !== undefined) {
    const explicitlySophomore = containsTerm(candidate, "sophomore");
    if (explicitlySophomore) {
      adjustments.push({
        category: "sophomore-eligibility",
        points: job.sophomoreEligible ? 6 : -12,
        evidence: job.sophomoreEligible
          ? "Posting permits sophomores and approved evidence explicitly says sophomore."
          : "Posting excludes sophomores while approved evidence explicitly says sophomore.",
      });
      if (!job.sophomoreEligible) hardFailures.push("sophomore-eligibility");
    } else {
      missingEvidence.push("class-year");
    }
  }

  const requiredDegrees = DEGREE_TERMS.filter((degree) => containsTerm(posting, degree));
  if (requiredDegrees.length > 0) {
    const supportedDegree = requiredDegrees.find((degree) => containsTerm(candidate, degree));
    adjustments.push({
      category: "degree-major",
      points: supportedDegree ? 10 : -8,
      evidence: supportedDegree
        ? `Approved education evidence names ${supportedDegree}.`
        : "Posting names a degree/major not present in approved evidence.",
    });
  } else {
    missingEvidence.push("degree-major");
  }

  // Sponsorship is adjusted only when an approved fact explicitly says it.
  // Resume facts normally omit it, which correctly leaves this category neutral.
  const sponsorship = normalized(job.sponsorship);
  const explicitlyNeedsSponsorship = /\b(require|need|seeking)\w* sponsorship\b/.test(candidate);
  const explicitlyNoSponsorship = /\b(do not|does not|no|without)\s+(require|need)\w* sponsorship\b/.test(candidate);
  if (sponsorship === "no" && (explicitlyNeedsSponsorship || explicitlyNoSponsorship)) {
    const compatible = explicitlyNoSponsorship;
    adjustments.push({
      category: "sponsorship",
      points: compatible ? 8 : -24,
      evidence: compatible
        ? "Posting offers no sponsorship and approved evidence explicitly says none is required."
        : "Posting offers no sponsorship and approved evidence explicitly says it is required.",
    });
    if (!compatible) hardFailures.push("sponsorship");
  } else {
    missingEvidence.push("sponsorship");
  }

  if (job.citizenshipOrClearance) {
    const clearanceEvidence = /\b(clearance|u\.?s\.? citizen|citizenship)\b/.test(candidate);
    if (clearanceEvidence) {
      adjustments.push({ category: "citizenship-clearance", points: 5, evidence: "Approved evidence explicitly addresses the posting restriction." });
    } else {
      missingEvidence.push("citizenship-clearance");
    }
  }

  const raw = 50 + adjustments.reduce((total, item) => total + item.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const eligibilityStatus = hardFailures.length > 0
    ? "Fail"
    : adjustments.length >= 3
      ? "Pass"
      : "Unknown";
  const explanation = JSON.stringify({
    version: BASELINE_RUBRIC_VERSION,
    neutralBase: 50,
    adjustments,
    missingEvidence: Array.from(new Set(missingEvidence)).sort(),
    hardFailures,
  });

  return {
    score,
    eligibilityStatus,
    scoreSource: BASELINE_SCORE_SOURCE,
    profileRevision: profile.revision,
    jobFingerprint: fingerprintJobScoringInput(job),
    explanation,
  };
}

export async function loadApprovedBaselineProfile(userId: string): Promise<BaselineProfile | null> {
  const delegate = (prisma as unknown as { resumeFact?: typeof prisma.resumeFact }).resumeFact;
  if (!delegate?.findMany) return null;
  const facts = await delegate.findMany({
    where: { userId, status: { in: ["approved", "edited"] } },
    orderBy: { id: "asc" },
    select: { id: true, type: true, content: true, detail: true },
  });
  if (facts.length === 0) return null;
  return { userId, revision: fingerprintApprovedFacts(facts), facts };
}

export async function loadAllApprovedBaselineProfiles(): Promise<BaselineProfile[]> {
  const delegate = (prisma as unknown as { resumeFact?: typeof prisma.resumeFact }).resumeFact;
  if (!delegate?.findMany) return [];
  const facts = await delegate.findMany({
    where: { userId: { not: null }, status: { in: ["approved", "edited"] } },
    orderBy: [{ userId: "asc" }, { id: "asc" }],
    select: { id: true, userId: true, type: true, content: true, detail: true },
  });
  const byUser = new Map<string, FingerprintFact[]>();
  for (const fact of facts) {
    if (!fact.userId) continue;
    const existing = byUser.get(fact.userId) ?? [];
    existing.push(fact);
    byUser.set(fact.userId, existing);
  }
  return [...byUser.entries()].map(([userId, userFacts]) => ({
    userId,
    revision: fingerprintApprovedFacts(userFacts),
    facts: userFacts,
  }));
}

export function baselineStateData(score: BaselineScore) {
  return {
    matchScore: score.score,
    eligibilityStatus: score.eligibilityStatus,
    matchedAt: new Date(),
    scoreSource: score.scoreSource,
    scoreProfileRevision: score.profileRevision,
    scoreJobFingerprint: score.jobFingerprint,
    scoreExplanation: score.explanation,
  };
}

const BASELINE_JOB_SELECT = {
  id: true,
  title: true,
  company: true,
  location: true,
  workplaceType: true,
  internshipTerm: true,
  description: true,
  jobResponsibilities: true,
  jobQualifications: true,
  disciplineTags: true,
  sophomoreEligible: true,
  graduationYears: true,
  sponsorship: true,
  citizenshipOrClearance: true,
  season: true,
  sourcePostedAt: true,
} satisfies Prisma.JobSelect;

export type BaselineBackfillResult = {
  profileReady: boolean;
  active: number;
  processed: number;
  baselineWritten: number;
  alreadyCurrent: number;
};

export async function backfillBaselineScoresForUser(
  userId: string,
  options: { batchSize?: number } = {},
): Promise<BaselineBackfillResult> {
  const profile = await loadApprovedBaselineProfile(userId);
  if (!profile) return { profileReady: false, active: 0, processed: 0, baselineWritten: 0, alreadyCurrent: 0 };

  const batchSize = Math.max(10, Math.min(250, Math.trunc(options.batchSize ?? BASELINE_BACKFILL_BATCH_SIZE)));
  const jobs = await prisma.job.findMany({
    where: { activeFeed: true },
    orderBy: [
      { sourcePostedAt: { sort: "desc", nulls: "last" } },
      { id: "desc" },
    ],
    select: BASELINE_JOB_SELECT,
  });
  let baselineWritten = 0;
  let alreadyCurrent = 0;

  for (let offset = 0; offset < jobs.length; offset += batchSize) {
    const batch = jobs.slice(offset, offset + batchSize);
    const current = await prisma.userJobState.findMany({
      where: { userId, jobId: { in: batch.map((job) => job.id) } },
      select: {
        jobId: true,
        matchScore: true,
        scoreProfileRevision: true,
        scoreJobFingerprint: true,
      },
    });
    const currentByJob = new Map(current.map((state) => [state.jobId, state]));
    const creates: Prisma.UserJobStateCreateManyInput[] = [];
    const updates: Array<ReturnType<typeof prisma.userJobState.update>> = [];
    for (const job of batch) {
      const score = calculateBaselineScore(profile, job);
      const state = currentByJob.get(job.id);
      const currentScoreValid = Number.isInteger(state?.matchScore)
        && state!.matchScore! >= 0
        && state!.matchScore! <= 100;
      if (
        currentScoreValid
        && state?.scoreProfileRevision === score.profileRevision
        && state?.scoreJobFingerprint === score.jobFingerprint
      ) {
        alreadyCurrent += 1;
        continue;
      }
      const data = baselineStateData(score);
      if (state) {
        updates.push(prisma.userJobState.update({
          where: { userId_jobId: { userId, jobId: job.id } },
          data,
        }));
      } else {
        creates.push({ userId, jobId: job.id, ...data });
      }
      baselineWritten += 1;
    }
    if (creates.length > 0 || updates.length > 0) {
      const writes: Prisma.PrismaPromise<unknown>[] = [];
      if (creates.length > 0) {
        writes.push(prisma.userJobState.createMany({ data: creates, skipDuplicates: true }));
      }
      writes.push(...updates);
      await prisma.$transaction(writes);
    }
  }

  return {
    profileReady: true,
    active: jobs.length,
    processed: jobs.length,
    baselineWritten,
    alreadyCurrent,
  };
}

/** Recompute one changed/new job for every eligible user, newest work first. */
export async function baselineScoreJobForAllEligibleUsers(jobId: string): Promise<number> {
  const [job, profiles] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId }, select: BASELINE_JOB_SELECT }),
    loadAllApprovedBaselineProfiles(),
  ]);
  if (!job || profiles.length === 0) return 0;
  const current = await prisma.userJobState.findMany({
    where: { jobId, userId: { in: profiles.map((profile) => profile.userId) } },
    select: {
      userId: true,
      matchScore: true,
      scoreProfileRevision: true,
      scoreJobFingerprint: true,
    },
  });
  const currentByUser = new Map(current.map((state) => [state.userId, state]));
  const writes = profiles.flatMap((profile) => {
    const score = calculateBaselineScore(profile, job);
    const state = currentByUser.get(profile.userId);
    if (
      Number.isInteger(state?.matchScore)
      && state!.matchScore! >= 0
      && state!.matchScore! <= 100
      && state?.scoreProfileRevision === score.profileRevision
      && state?.scoreJobFingerprint === score.jobFingerprint
    ) return [];
    const data = baselineStateData(score);
    return prisma.userJobState.upsert({
      where: { userId_jobId: { userId: profile.userId, jobId } },
      create: { userId: profile.userId, jobId, ...data },
      update: data,
    });
  });
  if (writes.length > 0) await prisma.$transaction(writes);
  return writes.length;
}
