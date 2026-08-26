import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { matchJobDescriptionText } from "@/lib/matchWorkflow";

export const DOCUMENT_GENERATION_POLICY_REVISION = "application-autofill-v1";

export type DocumentFingerprintInputs = {
  websiteJobId: string;
  jobDescription: string;
  approvedProfile: unknown;
  approvedFacts: unknown;
  latestMatch: unknown;
  masterResumeRevision: unknown;
  generationPolicyRevision: string;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  if (typeof value === "string") return value.replace(/\r\n/g, "\n").trim();
  return value;
}

export function documentFingerprintFromInputs(input: DocumentFingerprintInputs): string {
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

async function sourceRevision(): Promise<string> {
  const files = [
    "templates/resume-template.typ",
    "templates/cover-letter-template.typ",
    "templates/master_resume_reference.pdf",
    "src/lib/documents/masterResume.ts",
    "src/lib/documents/generate.ts",
  ];
  const hash = createHash("sha256");
  for (const filename of files) {
    hash.update(filename);
    hash.update(await readFile(path.join(/* turbopackIgnore: true */ process.cwd(), filename)));
  }
  return hash.digest("hex");
}

type FingerprintJob = {
  id: string;
  matchResults: Array<{
    id: string;
    eligibility: string;
    score: number;
    skillsSupported: string;
    skillsNeedConfirmation: string;
    skillsNeverAdd: string;
    tailoringPreview: string | null;
    factsUsed: string;
    origin: string | null;
    createdAt: Date;
  }>;
} & Parameters<typeof matchJobDescriptionText>[0];

/**
 * Computes the exact freshness key used for both reuse and extension transfer.
 *
 * `preloadedJob` lets a caller that already holds the job (with the same
 * per-user `matchResults` shape this function needs) skip the read below —
 * enqueueApplication does, since it already loaded the job with its own
 * current-user matchResults before ever computing a fingerprint (pass #7,
 * item 2).
 */
export async function computeDocumentFingerprint(jobId: string, userId: string, preloadedJob?: FingerprintJob): Promise<string> {
  const [job, profile, facts, latestMasterResume, masterResumeRevision] = await Promise.all([
    preloadedJob
      ? Promise.resolve(preloadedJob)
      : prisma.job.findUnique({
          where: { id: jobId },
          include: { matchResults: { where: { userId }, orderBy: { createdAt: "desc" }, take: 1 } },
        }),
    applicationProfileForUser(userId),
    prisma.resumeFact.findMany({
      where: { userId, status: { in: ["approved", "edited"] } },
      orderBy: { id: "asc" },
      select: { id: true, type: true, content: true, detail: true, status: true, updatedAt: true },
    }),
    prisma.resumeDocument.findFirst({
      where: { userId, kind: "resume" },
      orderBy: { createdAt: "desc" },
      select: { id: true, sizeBytes: true, pageCount: true, createdAt: true },
    }),
    sourceRevision(),
  ]);
  if (!job) throw new Error("Job not found while computing document freshness.");
  const match = job.matchResults[0] ?? null;
  return documentFingerprintFromInputs({
    websiteJobId: job.id,
    jobDescription: matchJobDescriptionText(job),
    approvedProfile: profile,
    approvedFacts: facts,
    latestMatch: match
      ? {
          id: match.id,
          eligibility: match.eligibility,
          score: match.score,
          skillsSupported: match.skillsSupported,
          skillsNeedConfirmation: match.skillsNeedConfirmation,
          skillsNeverAdd: match.skillsNeverAdd,
          tailoringPreview: match.tailoringPreview,
          factsUsed: match.factsUsed,
          origin: match.origin,
          createdAt: match.createdAt,
        }
      : null,
    masterResumeRevision: { source: masterResumeRevision, uploaded: latestMasterResume },
    generationPolicyRevision: DOCUMENT_GENERATION_POLICY_REVISION,
  });
}
