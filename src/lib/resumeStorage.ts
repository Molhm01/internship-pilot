import path from "node:path";
import { deleteStoredObject, writeStoredObject } from "@/lib/storage";

/**
 * Uploaded résumé/cover-letter PDFs.
 *
 * The bytes go through the storage abstraction rather than straight to disk,
 * so the same upload route works on a laptop and on a serverless deployment
 * where nothing written during a request survives it.
 */
function storageDirectory(): string {
  return process.env.RESUME_STORAGE_DIR ?? path.posix.join("data", "resumes");
}

/** The storage key a freshly uploaded résumé is written under. */
export function resumeStoragePath(documentId: string): string {
  return path.posix.join(storageDirectory().replace(/\\/g, "/"), `${documentId}.pdf`);
}

/**
 * Stores the PDF and returns the durable identifier for `storagePath` — a
 * repository-relative path locally, a blob URL in production.
 */
export async function saveResumePdf(documentId: string, bytes: Uint8Array): Promise<string> {
  return writeStoredObject(resumeStoragePath(documentId), bytes, {
    contentType: "application/pdf",
  });
}

export async function deleteResumePdf(storageKey: string): Promise<void> {
  await deleteStoredObject(storageKey);
}
