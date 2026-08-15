import path from "node:path";
import { deleteStoredObject, writeStoredObject } from "@/lib/storage";

/**
 * Uploaded résumé/cover-letter PDFs.
 *
 * The bytes go through the storage abstraction rather than straight to disk,
 * so the same upload route works on a laptop and on a serverless deployment
 * where nothing written during a request survives it.
 *
 * ## Why the key carries the user id
 *
 * Keys used to be `data/resumes/<documentId>.pdf` — one flat namespace for
 * everybody. On Vercel Blob that namespace is served over public, unguessable
 * URLs, so a leaked or logged URL is a permanent disclosure and there is no
 * later authorization step that can take it back. Writing under
 * `users/<userId>/…` means one person's documents are a subtree, which makes
 * a mistake in a prefix a visible mistake rather than a silent shared folder.
 *
 * The key is not the access control — that is `GET /api/documents/[id]/download`
 * and its ownership check. It is the second line, and the one that survives a
 * bug in the first.
 */
function storageDirectory(): string {
  return process.env.RESUME_STORAGE_DIR ?? path.posix.join("data", "resumes");
}

/** The storage key a freshly uploaded résumé is written under. */
export function resumeStoragePath(userId: string, documentId: string): string {
  return path.posix.join(
    storageDirectory().replace(/\\/g, "/"),
    "users",
    userId,
    `${documentId}.pdf`,
  );
}

/**
 * Stores the PDF and returns the durable identifier for `storagePath` — a
 * repository-relative path locally, a blob URL in production.
 */
export async function saveResumePdf(
  userId: string,
  documentId: string,
  bytes: Uint8Array,
): Promise<string> {
  return writeStoredObject(resumeStoragePath(userId, documentId), bytes, {
    contentType: "application/pdf",
  });
}

export async function deleteResumePdf(storageKey: string): Promise<void> {
  await deleteStoredObject(storageKey);
}
