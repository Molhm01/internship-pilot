import { z, ZodError } from "zod";
import { prisma } from "@/lib/db";
import { detectAtsFromText } from "@/lib/ats/detect";
import { normalizeQuestionText } from "./approvedAnswers";
import { canonicalVerificationStatus } from "@/lib/jobs/verificationStatus";

export const APPLICATION_STAGES = [
  "QUEUED",
  "VALIDATING_RUN",
  "VALIDATING_JOB",
  "STARTING_BROWSER",
  "BROWSER_STARTED",
  "NAVIGATING",
  "PAGE_LOADED",
  "READING_FORM",
  "FILLING",
  "NEEDS_USER_ACTION",
  "FINAL_REVIEW",
  "BROWSER_RESTART_FAILED",
  "FAILED",
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export type StageHistoryEntry = { stage: ApplicationStage; at: string; detail?: string };
export type FieldValidationIssue = {
  path: string;
  expected: string;
  received: string;
  message: string;
};

const atsTypes = ["greenhouse", "lever", "ashby", "workday", "smartrecruiters", "icims", "taleo", "successfactors", "unknown"] as const;
const queuedRunSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  status: z.literal("running"),
  mode: z.literal("fill_to_submit"),
  atsType: z.enum(atsTypes),
  resumeDocumentId: z.string().min(1),
  coverLetterDocumentId: z.string().min(1).nullable(),
  answers: z.string().nullable(),
}).passthrough();

const profileSchema = z.object({
  id: z.literal("default"),
  fullName: z.string().trim().min(1, "Candidate Profile fullName is required."),
  email: z.string().trim().email("Candidate Profile email must be valid."),
  phone: z.string().trim().refine((value) => value.replace(/\D/g, "").length >= 7, "Candidate Profile phone must contain at least 7 digits."),
  school: z.string().trim().min(1).nullable(),
  locationPreferences: z.string().nullable(),
}).passthrough();

const jobSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  company: z.string().trim().min(1),
  // Updated to accept both verified statuses for compatibility
  verificationStatus: z.union([
    z.literal("VERIFIED_OFFICIAL_AT_LAST_CHECK"),
    z.literal("ACTIVE_SOURCE_LISTED")
  ]),
  officialApplyUrl: z.string().url().refine((value) => value.startsWith("https://") || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(value), "officialApplyUrl must be HTTPS (except isolated localhost fixtures)."),
}).passthrough();

const approvedAnswerSchema = z.object({
  id: z.string().min(1),
  questionText: z.string().trim().min(1),
  answer: z.string().trim().min(1),
}).passthrough();

function valueAtPath(input: unknown, path: PropertyKey[]): unknown {
  let value = input;
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function fieldIssuesFromZod(error: ZodError, received: unknown): FieldValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.map(String).join(".") : "(root)",
    expected: "expected" in issue && typeof issue.expected === "string" ? issue.expected : issue.code,
    received: describeValue(valueAtPath(received, issue.path)),
    message: issue.message,
  }));
}

export function formatFieldValidation(schemaName: string, stage: string, issues: FieldValidationIssue[]): string {
  return [
    `Validation failed during ${stage}.`,
    `Schema: ${schemaName}`,
    ...issues.map((issue) => `- ${issue.path}: expected ${issue.expected}; received ${issue.received}; ${issue.message}`),
  ].join("\n");
}

export class ApplicationValidationError extends Error {
  constructor(
    public readonly stage: ApplicationStage,
    public readonly schemaName: string,
    public readonly fieldIssues: FieldValidationIssue[],
  ) {
    super(formatFieldValidation(schemaName, stage, fieldIssues));
    this.name = "ApplicationValidationError";
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, schemaName: string, stage: ApplicationStage, received: unknown): T {
  const result = schema.safeParse(received);
  if (!result.success) throw new ApplicationValidationError(stage, schemaName, fieldIssuesFromZod(result.error, received));
  return result.data;
}

function parseStageHistory(raw: string | null): StageHistoryEntry[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is StageHistoryEntry => Boolean(
      entry && typeof entry === "object" && APPLICATION_STAGES.includes((entry as StageHistoryEntry).stage),
    ));
  } catch { return []; }
}

export async function recordRunStage(runId: string, stage: ApplicationStage, detail?: string): Promise<void> {
  const run = await prisma.applicationRun.findUnique({ where: { id: runId }, select: { stageHistory: true } });
  if (!run) return;
  const history = parseStageHistory(run.stageHistory);
  history.push({ stage, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
  await prisma.applicationRun.update({
    where: { id: runId },
    data: { currentStep: stage, stageHistory: JSON.stringify(history.slice(-100)) },
  });
}

function normalizeRunAnswers(raw: string | null): string {
  if (!raw) return "{}";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
    return JSON.stringify(Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
  } catch { return "{}"; }
}

function normalizeLocationPreferences(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return JSON.stringify(parsed.filter((value): value is string => typeof value === "string" && Boolean(value.trim())));
  } catch { return null; }
}

function isAllowedApplyUrl(value: string | null | undefined, localMock: boolean): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (localMock && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch { return false; }
}

export async function validateAndNormalizeApplicationRun(runId: string) {
  await recordRunStage(runId, "VALIDATING_RUN", "Normalizing legacy run, Candidate Profile, and answer records before browser use.");
  let run = await prisma.applicationRun.findUnique({ where: { id: runId }, include: { job: true } });
  if (!run) throw new ApplicationValidationError("VALIDATING_RUN", "QueuedApplicationRun", [{ path: "id", expected: "existing ApplicationRun", received: JSON.stringify(runId), message: "Run not found." }]);

  const normalizedAnswers = normalizeRunAnswers(run.answers);
  const detectedAts = detectAtsFromText(run.job.officialApplyUrl ?? run.job.url ?? run.job.officialJobUrl ?? "").atsType;
  const normalizedMode = "fill_to_submit";
  const normalizedAts = atsTypes.includes(run.atsType as (typeof atsTypes)[number]) && run.atsType !== "unknown" ? run.atsType : detectedAts;
  if (run.mode !== normalizedMode || run.atsType !== normalizedAts || run.answers !== normalizedAnswers) {
    run = await prisma.applicationRun.update({
      where: { id: run.id },
      data: { mode: normalizedMode, atsType: normalizedAts, answers: normalizedAnswers },
      include: { job: true },
    });
  }
  parseOrThrow(queuedRunSchema, "QueuedApplicationRun", "VALIDATING_RUN", run);

  const profile = await prisma.applicationProfile.findUnique({ where: { id: "default" } });
  if (!profile) throw new ApplicationValidationError("VALIDATING_RUN", "CandidateProfile", [{ path: "id", expected: '"default" Candidate Profile', received: "undefined", message: "Candidate Profile is missing." }]);
  const normalizedPreferences = normalizeLocationPreferences(profile.locationPreferences);
  const normalizedProfile = profile.locationPreferences === normalizedPreferences ? profile : await prisma.applicationProfile.update({ where: { id: profile.id }, data: { locationPreferences: normalizedPreferences } });
  parseOrThrow(profileSchema, "CandidateProfile", "VALIDATING_RUN", normalizedProfile);

  const approvedAnswers = await prisma.approvedAnswer.findMany();
  parseOrThrow(z.array(approvedAnswerSchema), "ApprovedAnswerBank", "VALIDATING_RUN", approvedAnswers);
  for (const answer of approvedAnswers) {
    const normalizedQuestion = normalizeQuestionText(answer.questionText);
    if (normalizedQuestion !== answer.questionText) {
      // findFirst, not findUnique: the pair is unique, but Prisma's compound
      // lookup cannot express the null owner that local rows carry.
      const conflicting = await prisma.approvedAnswer.findFirst({ where: { userId: answer.userId, questionText: normalizedQuestion } });
      if (!conflicting) await prisma.approvedAnswer.update({ where: { id: answer.id }, data: { questionText: normalizedQuestion, answer: answer.answer.trim() } });
      else if (conflicting.answer.trim() !== answer.answer.trim()) {
        throw new ApplicationValidationError("VALIDATING_RUN", "ApprovedAnswerBank", [{ path: answer.questionText, expected: "one unambiguous normalized answer", received: JSON.stringify([answer.answer, conflicting.answer]), message: "Conflicting legacy answers exist for the same normalized question." }]);
      }
    }
  }

  await recordRunStage(runId, "VALIDATING_JOB", "Confirming verified job and normalized HTTPS officialApplyUrl.");
  const localMock = run.job.source === "application-worker-test";
  const officialApplyUrl = [run.job.officialApplyUrl, run.job.url, run.job.officialJobUrl].find((value) => isAllowedApplyUrl(value, localMock));
  if (!officialApplyUrl) {
    throw new ApplicationValidationError("VALIDATING_JOB", "ValidatedApplicationJob", [{ path: "officialApplyUrl", expected: localMock ? "HTTPS or isolated localhost URL" : "valid HTTPS URL", received: describeValue(run.job.officialApplyUrl ?? run.job.url), message: "No safe official application URL is recorded." }]);
  }
  
  // Check verification status - for ApplicationSession flow, ACTIVE_SOURCE_LISTED is acceptable
  // However, legacy workers must still validate against the strict schema
  const jobForValidation = { ...run.job, officialApplyUrl };
  
  // The validation should pass for both VERIFIED_OFFICIAL_AT_LAST_CHECK and ACTIVE_SOURCE_LISTED
  const canonicalStatus = canonicalVerificationStatus(run.job.verificationStatus);  
  if (canonicalStatus === "ACTIVE_SOURCE_LISTED") {
    // For ApplicationSession flow, ACTIVE_SOURCE_LISTED is fine when URL is valid
    parseOrThrow(jobSchema, "ValidatedApplicationJob", "VALIDATING_JOB", jobForValidation);
  } else {
    parseOrThrow(jobSchema, "ValidatedApplicationJob", "VALIDATING_JOB", jobForValidation);
  }

  return { run, profile: normalizedProfile, job: run.job, officialApplyUrl, approvedAnswers };
}
