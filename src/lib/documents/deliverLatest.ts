import path from "node:path";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/db";
import {
  deliverDocumentToAgent,
  tailoredFilename,
  type AgentDeliveryOutcome,
  type AgentDocumentType,
} from "@/lib/documents/agentDelivery";

/**
 * Resending documents that already exist.
 *
 * Generation delivers each PDF as it is produced, but a delivery can fail for
 * reasons that have nothing to do with the document: the agent was not running,
 * or the two sides had drifted onto different tokens. Regenerating in that case
 * would burn a minute of compilation and a new version row to fix a transport
 * problem, so the stored bytes are re-read from disk and sent again instead.
 *
 * The files on disk are the same ones the download route serves, so what the
 * agent receives here is byte-identical to what the user sees in the browser.
 */

/** `type` values as stored on GeneratedDocument, mapped to the agent's enum. */
const AGENT_TYPE: Record<string, AgentDocumentType> = {
  resume: "resume",
  coverLetter: "cover_letter",
};

export type LatestDeliveryReport = {
  resume: AgentDeliveryOutcome | null;
  coverLetter: AgentDeliveryOutcome | null;
};

export class NoStoredDocumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoStoredDocumentsError";
  }
}

function absolute(relativePath: string): string {
  return path.isAbsolute(relativePath) ? relativePath : path.join(process.cwd(), relativePath);
}

async function deliverStored(
  storedType: "resume" | "coverLetter",
  jobId: string,
  job: { company: string; title: string },
  deliver: typeof deliverDocumentToAgent,
): Promise<AgentDeliveryOutcome | null> {
  const documentType = AGENT_TYPE[storedType];
  // Only a document that passed QA is eligible. An archived or failed version is
  // never attached to an application, so sending it to the agent would put a
  // file in front of an employer that this system already rejected.
  const latest = await prisma.generatedDocument.findFirst({
    where: { jobId, type: storedType, qaStatus: "pass" },
    orderBy: { version: "desc" },
  });
  if (!latest) return null;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(absolute(latest.storagePath)));
  } catch {
    return {
      delivered: false,
      documentType,
      reason: "The generated PDF is recorded but its file is missing on disk. Generate the document again.",
    };
  }

  return deliver({
    documentType,
    filename: tailoredFilename(documentType, job.company, job.title),
    bytes,
    source: "tailored",
    company: job.company,
    jobTitle: job.title,
    jobId,
    createdAt: latest.createdAt.toISOString(),
  });
}

/**
 * Re-sends the newest QA-passed résumé and cover letter for one job.
 *
 * Each document is reported separately: a cover letter the agent accepted is
 * still delivered even if the résumé's own send failed, and the caller must be
 * able to say so rather than collapsing both into one verdict.
 */
export async function deliverLatestDocumentsForJob(
  jobId: string,
  deliver: typeof deliverDocumentToAgent = deliverDocumentToAgent,
): Promise<LatestDeliveryReport> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { company: true, title: true },
  });
  if (!job) throw new NoStoredDocumentsError("That job no longer exists.");

  // Sequential rather than parallel: the agent writes both files into one
  // directory and updates one "latest" pointer per type, and two concurrent
  // uploads buy nothing on loopback.
  const resume = await deliverStored("resume", jobId, job, deliver);
  const coverLetter = await deliverStored("coverLetter", jobId, job, deliver);

  if (!resume && !coverLetter) {
    throw new NoStoredDocumentsError(
      "No generated documents are stored for this job yet. Generate them first.",
    );
  }

  return { resume, coverLetter };
}
