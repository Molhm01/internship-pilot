import { prisma } from "@/lib/db";
import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { extractPdfText } from "@/lib/pdf";
import { readStoredObject } from "@/lib/storage";

const MOCK_IDENTITY_PATTERNS = [
  /\bJordan Test\b/i,
  /\bTest Candidate\b/i,
  /\bjordan\.test@example\.com\b/i,
  /\btest\.candidate@example\.com\b/i,
  /\bTest University\b/i,
  /\b555[- )]*(?:000[- ]*1111|0100)\b/i,
  /\b[A-Z0-9._%+-]+@example\.com\b/i,
];

export type IdentityProfile = { fullName: string | null; email: string | null; phone: string | null };

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

export function validateDocumentIdentity(text: string, profile: IdentityProfile): string[] {
  const issues: string[] = [];
  const name = profile.fullName?.trim();
  const email = profile.email?.trim();
  const phone = profile.phone?.trim();
  if (!name || !text.includes(name)) issues.push("PDF name does not exactly match the saved Candidate Profile.");
  if (!email || !text.toLowerCase().includes(email.toLowerCase())) issues.push("PDF email does not match the saved Candidate Profile.");
  const pdfDigits = digits(text);
  const phoneDigits = digits(phone ?? "");
  if (!phoneDigits || !pdfDigits.includes(phoneDigits)) issues.push("PDF telephone does not match the saved Candidate Profile.");
  for (const pattern of MOCK_IDENTITY_PATTERNS) {
    if (pattern.test(text)) issues.push(`Forbidden mock identity detected: ${pattern.source}`);
  }
  return Array.from(new Set(issues));
}

/**
 * Checks that a generated PDF carries the identity of the person it belongs to.
 *
 * The profile is loaded from the document's OWN owner rather than from a shared
 * row. That is what makes the guard meaningful in a multi-user system: its
 * whole job is to catch a résumé that names somebody other than the applicant,
 * and comparing every document against one installation-wide profile would
 * have failed every document except one person's — while passing a document
 * that had genuinely been generated with the wrong name.
 */
export async function verifyGeneratedDocumentIdentity(documentId: string): Promise<{ text: string; issues: string[] }> {
  const document = await prisma.generatedDocument.findUnique({ where: { id: documentId } });
  if (!document) throw new Error("Generated document not found.");
  if (!document.userId) throw new Error("This generated document has no owner to verify against.");
  const profile = await applicationProfileForUser(document.userId);
  if (!profile) throw new Error("Candidate Profile not found.");
  // Through the storage layer, not readFile. This runs inside
  // /api/extension/documents/[id] — the one route a hosted deployment depends
  // on most, because the extension is the only bridge to the user's Agent. A
  // blob-URL storagePath is not a filesystem path, so reading it from disk
  // would throw here and the guard would report every document as failing the
  // identity check rather than as missing.
  const extraction = await extractPdfText(await readStoredObject(document.storagePath));
  const issues = validateDocumentIdentity(extraction.text, profile);
  await prisma.generatedDocument.update({
    where: { id: document.id },
    data: issues.length
      ? { qaStatus: "INVALID_TEST_DATA", identityVerified: false, qaIssues: JSON.stringify(issues) }
      : { identityVerified: true },
  });
  return { text: extraction.text, issues };
}

export async function assertGeneratedDocumentUploadable(documentId: string): Promise<void> {
  const document = await prisma.generatedDocument.findUnique({ where: { id: documentId } });
  if (!document || document.qaStatus !== "pass") throw new Error("The selected document is not QA-approved for upload.");
  const result = await verifyGeneratedDocumentIdentity(documentId);
  if (result.issues.length) throw new Error("The selected document failed the production identity guard and will not be uploaded.");
}

export async function invalidateExistingMockDocuments(): Promise<{ scanned: number; invalidated: number; ids: string[] }> {
  const documents = await prisma.generatedDocument.findMany({ where: { storagePath: { not: "" } } });
  let scanned = 0;
  const ids: string[] = [];
  for (const document of documents) {
    try {
      const result = await verifyGeneratedDocumentIdentity(document.id);
      scanned += 1;
      if (result.issues.length) ids.push(document.id);
    } catch {
      // Missing legacy files are handled by their existing QA state; this
      // audit specifically classifies readable PDFs containing mock data.
    }
  }
  return { scanned, invalidated: ids.length, ids };
}
