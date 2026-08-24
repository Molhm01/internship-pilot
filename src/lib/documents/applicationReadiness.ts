import { prisma } from "@/lib/db";
import { generateDocumentsForJob } from "./generate";
import { computeDocumentFingerprint } from "./documentFingerprint";

type ReadyDocument = Awaited<ReturnType<typeof prisma.generatedDocument.findMany>>[number];

export type ApplicationDocumentReadiness = {
  fingerprint: string;
  reused: boolean;
  documents: ReadyDocument[];
};

function newest(documents: ReadyDocument[], type: "resume" | "coverLetter") {
  return documents
    .filter((document) => document.type === type)
    .sort((left, right) => right.version - left.version)[0] ?? null;
}

export function reusableApplicationDocuments<T extends {
  jobId: string;
  userId: string | null;
  type: string;
  version: number;
  qaStatus: string;
  identityVerified: boolean;
  documentFingerprint: string | null;
}>(documents: T[], input: { jobId: string; userId: string; fingerprint: string; includeCoverLetter: boolean }): T[] | null {
  const valid = documents.filter((document) =>
    document.jobId === input.jobId
    && document.userId === input.userId
    && document.documentFingerprint === input.fingerprint
    && document.qaStatus === "pass"
    && document.identityVerified,
  );
  const resume = valid.filter((document) => document.type === "resume").sort((a, b) => b.version - a.version)[0];
  const cover = valid.filter((document) => document.type === "coverLetter").sort((a, b) => b.version - a.version)[0];
  if (!resume || (input.includeCoverLetter && !cover)) return null;
  return [resume, ...(cover ? [cover] : [])];
}

/** Reuses only QA-passed documents whose complete freshness fingerprint matches. */
export async function ensureApplicationDocuments(
  jobId: string,
  userId: string,
  options: { includeCoverLetter: boolean },
): Promise<ApplicationDocumentReadiness> {
  const fingerprint = await computeDocumentFingerprint(jobId, userId);
  const existing = await prisma.generatedDocument.findMany({
    where: {
      jobId,
      userId,
      documentFingerprint: fingerprint,
      qaStatus: "pass",
      identityVerified: true,
    },
    orderBy: [{ type: "asc" }, { version: "desc" }],
  });
  const reusable = reusableApplicationDocuments(existing, { jobId, userId, fingerprint, includeCoverLetter: options.includeCoverLetter });
  if (reusable) {
    return { fingerprint, reused: true, documents: reusable };
  }

  const generated = await generateDocumentsForJob(jobId, userId, {
    includeCoverLetter: options.includeCoverLetter,
    documentFingerprint: fingerprint,
  });
  const ids = [generated.resume.id, ...(generated.coverLetter ? [generated.coverLetter.id] : [])];
  const documents = await prisma.generatedDocument.findMany({
    where: { id: { in: ids }, userId, jobId },
    orderBy: [{ type: "asc" }, { version: "desc" }],
  });
  const generatedResume = newest(documents, "resume");
  const generatedCover = newest(documents, "coverLetter");
  if (!generatedResume || generatedResume.qaStatus !== "pass" || !generatedResume.identityVerified) {
    throw new Error("The freshly generated résumé did not pass document QA.");
  }
  if (options.includeCoverLetter && (!generatedCover || generatedCover.qaStatus !== "pass" || !generatedCover.identityVerified)) {
    throw new Error("The freshly generated cover letter did not pass document QA.");
  }
  return { fingerprint, reused: false, documents };
}
