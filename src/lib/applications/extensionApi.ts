import { z } from "zod";
import { prisma } from "@/lib/db";
import { MASTER_EDUCATION, MASTER_EXPERIENCE } from "@/lib/documents/masterResume";
import { classifyField, lookupAnswer } from "./answerBank";
import { normalizeQuestionText } from "./approvedAnswers";
import type { FillContext } from "./types";
import { isActiveAvailability, canonicalAvailability, AVAILABILITY } from "@/lib/jobs/verificationModel";
import { isUsableResume } from "@/lib/documents/strategy";

const blockerSchema = z.object({
  kind: z.enum(["captcha", "mfa", "login", "signature", "legal", "assessment"]),
  detail: z.string().min(1).max(2_000),
}).strict();

export const extensionFieldSchema = z.object({
  index: z.number().int().min(0).max(500),
  label: z.string().max(2_000),
  groupLabel: z.string().max(2_000).default(""),
  optionLabel: z.string().max(1_000).default(""),
  name: z.string().max(1_000).default(""),
  id: z.string().max(1_000).default(""),
  ariaLabel: z.string().max(2_000).default(""),
  placeholder: z.string().max(2_000).default(""),
  nearbyText: z.string().max(4_000).default(""),
  role: z.string().max(200).default(""),
  type: z.string().min(1).max(100),
  required: z.boolean(),
  options: z.array(z.string().max(1_000)).max(200),
  currentValue: z.string().max(10_000),
}).strict();

export const extensionFillPlanRequestSchema = z.object({
  runId: z.string().min(1).max(200).nullable().optional(),
  pageUrl: z.string().url(),
  pageTitle: z.string().max(2_000),
  fields: z.array(extensionFieldSchema).min(1).max(500),
  blockers: z.array(blockerSchema).max(20),
}).strict();

export const extensionReportSchema = z.object({
  runId: z.string().min(1).max(200),
  pageUrl: z.string().url(),
  jobId: z.string().min(1).max(200),
  state: z.enum(["filled", "needs_user", "blocked", "no_form", "error"]),
  blockers: z.array(blockerSchema).max(20),
  filledCount: z.number().int().min(0).max(500),
  uploadedCount: z.number().int().min(0).max(10),
  answers: z.record(z.string(), z.string()).default({}),
  needsUser: z.array(z.object({
    label: z.string().min(1).max(2_000),
    reason: z.string().min(1).max(4_000),
    required: z.boolean(),
    type: z.string().max(100).default("unknown"),
    options: z.array(z.string().max(1_000)).max(200).default([]),
    ariaLabel: z.string().max(2_000).default(""),
    placeholder: z.string().max(2_000).default(""),
    nearbyText: z.string().max(4_000).default(""),
  }).strict()).max(100),
}).strict();

type ExtensionField = z.infer<typeof extensionFieldSchema>;
type FillPlanRequest = z.infer<typeof extensionFillPlanRequestSchema>;

const LEGAL_OR_SIGNATURE = /\b(certif(?:y|ication)|attest|signature|terms (?:of|&|and) (?:service|use)|i agree|acknowledge|consent|legally authorized|work authorization|authorized to work|sponsorship|citizen(?:ship)?|visa|security clearance)\b/i;
const SENSITIVE_CATEGORY = new Set(["work_authorization", "eeo"]);

function sameApplicationUrl(officialUrl: string | null, currentUrl: string): boolean {
  if (!officialUrl) return false;
  try {
    const official = new URL(officialUrl);
    const current = new URL(currentUrl);
    const officialPath = official.pathname.replace(/\/+$/, "");
    const currentPath = current.pathname.replace(/\/+$/, "");
    return official.origin === current.origin
      && (currentPath === officialPath || currentPath.startsWith(`${officialPath}/`));
  } catch {
    return false;
  }
}

async function findRunForPage(runId: string | null | undefined, pageUrl: string) {
  const include = {
    job: { include: { generatedDocuments: true } },
  } as const;
  if (runId) {
    const run = await prisma.applicationRun.findUnique({ where: { id: runId }, include });
    if (!run) throw new Error("The extension could not find this ApplicationRun.");
    if (!sameApplicationUrl(run.job.officialApplyUrl ?? run.job.url ?? run.job.officialJobUrl, pageUrl)) {
      throw new Error("The current page does not match the verified application URL for this run.");
    }
    return run;
  }
  const candidates = await prisma.applicationRun.findMany({
    where: { status: { in: ["queued", "running", "needs_user_action", "filled"] } },
    include,
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  const run = candidates.find((candidate) =>
    sameApplicationUrl(candidate.job.officialApplyUrl ?? candidate.job.url ?? candidate.job.officialJobUrl, pageUrl),
  );
  if (!run) throw new Error("Start this application from Internship Pilot before using manual extension autofill.");
  return run;
}

function parseRunAnswers(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function profileContext(profile: NonNullable<Awaited<ReturnType<typeof prisma.applicationProfile.findUnique>>>) {
  let locationPreferences: string[] | null = null;
  try {
    const parsed = JSON.parse(profile.locationPreferences ?? "null");
    locationPreferences = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    locationPreferences = null;
  }
  return {
    fullName: profile.fullName,
    preferredName: profile.preferredName,
    email: profile.email,
    phone: profile.phone,
    linkedin: profile.linkedin,
    github: profile.github,
    website: profile.website,
    school: profile.school,
    previousSchool: profile.previousSchool,
    addressStreet: profile.addressStreet,
    addressCity: profile.addressCity,
    addressState: profile.addressState,
    addressZip: profile.addressZip,
    countryOfResidence: profile.countryOfResidence,
    willingToRelocate: profile.willingToRelocate,
    locationPreferences,
    internshipTermAvailability: profile.internshipTermAvailability,
    salaryAnswerPreference: profile.salaryAnswerPreference,
    workAuthorization: profile.workAuthorization,
    requiresSponsorship: profile.requiresSponsorship,
    clearanceEligible: profile.clearanceEligible,
    eeoGender: profile.eeoGender,
    eeoRaceEthnicity: profile.eeoRaceEthnicity,
    eeoVeteranStatus: profile.eeoVeteranStatus,
    eeoDisabilityStatus: profile.eeoDisabilityStatus,
  };
}

function fieldDisplayLabel(field: ExtensionField): string {
  return field.groupLabel || field.label || field.ariaLabel || field.placeholder || field.nearbyText || field.name || "(Label unavailable)";
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function optionMatches(option: string, value: string): boolean {
  const left = normalized(option);
  const right = normalized(value);
  if (!left || !right) return false;
  if (left === right) return true;
  if (["yes", "no"].includes(left) || ["yes", "no"].includes(right)) return left === right;
  return left.includes(right) || right.includes(left);
}

export async function buildExtensionFillPlan(input: FillPlanRequest) {
  const run = await findRunForPage(input.runId, input.pageUrl);
  if (!["queued", "running", "needs_user_action", "filled"].includes(run.status)) {
    throw new Error(`ApplicationRun ${run.id} cannot be filled from status ${run.status}.`);
  }
  // The extension fills any ACTIVE job (officially verified, source listed, or
  // verification pending). It refuses only concrete negatives: a confirmed
  // closure, a destination mismatch, or a security block.
  const availability = canonicalAvailability(run.job.verificationStatus);
  if (availability === AVAILABILITY.SECURITY_BLOCKED || availability === AVAILABILITY.CLOSED_CONFIRMED || availability === AVAILABILITY.DESTINATION_MISMATCH) {
    throw new Error(`The extension refuses to fill a ${availability} application.`);
  }
  if (!isActiveAvailability(run.job.verificationStatus)) {
    throw new Error("The extension refuses to fill an application that is not currently active.");
  }
  const profile = await prisma.applicationProfile.findUnique({ where: { id: "default" } });
  if (!profile?.fullName || !profile.email || !profile.phone || !profile.school) {
    throw new Error("Candidate Profile is missing a required identity field.");
  }

  const resume = run.job.generatedDocuments.find((document) => document.id === run.resumeDocumentId);
  const coverLetter = run.job.generatedDocuments.find((document) => document.id === run.coverLetterDocumentId);
  // Any QA-passed, identity-verified resume for this job is uploadable —
  // including a master-resume fallback. Tailoring completeness never blocks.
  if (!resume || resume.jobId !== run.jobId || !isUsableResume(resume)) {
    throw new Error("This run does not have a job-specific, QA-passed, identity-verified resume.");
  }
  if (coverLetter && (coverLetter.jobId !== run.jobId || coverLetter.type !== "coverLetter" || coverLetter.qaStatus !== "pass" || !coverLetter.identityVerified)) {
    throw new Error("The selected cover letter is not job-specific, QA-passed, and identity-verified.");
  }

  const approvedRows = await prisma.approvedAnswer.findMany();
  const reusableAnswers = new Map(approvedRows.map((row) => [row.questionText, row.answer]));
  const runAnswers = parseRunAnswers(run.answers);
  const ctx: FillContext = {
    jobId: run.jobId,
    runId: run.id,
    jobTitle: run.job.title,
    company: run.job.company,
    applyUrl: run.job.officialApplyUrl ?? run.job.url ?? "",
    mode: "fill_to_submit",
    profile: profileContext(profile),
    resumeFilePath: resume.storagePath,
    coverLetterFilePath: coverLetter?.storagePath ?? null,
    coverLetterText: null,
    educationDegree: MASTER_EDUCATION[0]?.degree ?? null,
    recentExperience: MASTER_EXPERIENCE[0]
      ? `${MASTER_EXPERIENCE[0].title} — ${MASTER_EXPERIENCE[0].organization}`
      : null,
    approvedRunAnswers: runAnswers,
  };

  if (input.blockers.length > 0) {
    return {
      runId: run.id,
      job: { id: run.job.id, title: run.job.title, company: run.job.company },
      pause: input.blockers[0],
      fields: input.fields.map((field) => ({ index: field.index, action: "skip", reason: input.blockers[0].detail })),
    };
  }

  const instructions = input.fields.map((field) => {
    const label = fieldDisplayLabel(field);
    const category = classifyField(label);
    const normalizedQuestion = normalizeQuestionText(label);
    if (field.currentValue && !["false", "true"].includes(field.currentValue)) {
      return { index: field.index, action: "skip", reason: "The field already has a value; autofill will not overwrite it." };
    }
    if (LEGAL_OR_SIGNATURE.test(label) || SENSITIVE_CATEGORY.has(category)) {
      return { index: field.index, action: "leave_for_user", reason: "This legal, work-authorization, signature, or demographic question requires your explicit review." };
    }
    if (field.type === "file") {
      const cover = /cover\s*letter/i.test(label);
      if (cover) {
        return coverLetter
          ? { index: field.index, action: "upload_cover_letter", documentId: coverLetter.id }
          : { index: field.index, action: field.required ? "needs_user" : "skip", reason: "No job-specific QA-passed cover letter is attached to this run." };
      }
      return { index: field.index, action: "upload_resume", documentId: resume.id };
    }

    let value: string | null = runAnswers[normalizedQuestion] ?? lookupAnswer(ctx, label).value;
    if (value === null && category === "unknown") value = reusableAnswers.get(normalizedQuestion) ?? null;
    if (value === null) {
      return {
        index: field.index,
        action: field.required ? "needs_user" : "skip",
        reason: field.required ? "No approved, truthful answer is stored for this required question." : "Optional field has no approved answer.",
      };
    }
    if (field.type === "radio") {
      return optionMatches(field.optionLabel, value)
        ? { index: field.index, action: "check", value: true, answer: value }
        : { index: field.index, action: "skip", reason: "Another option in this radio group matches the approved answer." };
    }
    if (field.type === "checkbox") {
      const shouldCheck = /^(yes|true|checked)$/i.test(value);
      return shouldCheck
        ? { index: field.index, action: "check", value: true, answer: value }
        : { index: field.index, action: "skip", reason: "The approved answer does not require checking this box." };
    }
    if (field.type === "select" || field.role === "combobox") {
      return { index: field.index, action: "select", value };
    }
    return { index: field.index, action: "fill", value };
  });

  return {
    runId: run.id,
    job: { id: run.job.id, title: run.job.title, company: run.job.company },
    pause: null,
    fields: instructions,
  };
}

export async function recordExtensionReport(input: z.infer<typeof extensionReportSchema>): Promise<void> {
  const run = await prisma.applicationRun.findUnique({ where: { id: input.runId } });
  if (!run || run.jobId !== input.jobId) throw new Error("Extension report did not match its ApplicationRun.");
  await prisma.auditLogEntry.create({
    data: {
      jobId: run.jobId,
      actor: "application-agent",
      action: "extension-page-autofill",
      detail: `Extension reported ${input.state}: filled ${input.filledCount}, uploaded ${input.uploadedCount}, user-action fields ${input.needsUser.length}. Submit was not clicked.`,
      metadata: JSON.stringify({
        runId: run.id,
        pageUrl: input.pageUrl,
        state: input.state,
        blockers: input.blockers,
        needsUser: input.needsUser,
        answerLabels: Object.keys(input.answers),
      }),
    },
  });
}

export async function getExtensionRunState(id: string) {
  return prisma.applicationRun.findUnique({
    where: { id },
    select: {
      id: true,
      jobId: true,
      status: true,
      currentStep: true,
      needsUserActionReason: true,
      stoppedFieldLabel: true,
      stoppedFieldType: true,
      stoppedFieldOptions: true,
      stoppedFieldStep: true,
      stoppedFieldContext: true,
      screenshotPath: true,
      attemptNumber: true,
      errorCode: true,
      validationPath: true,
      protocolVersion: true,
      schemaVersion: true,
      tabRemainsOpen: true,
      errorLog: true,
      attemptHistory: true,
      updatedAt: true,
    },
  });
}
