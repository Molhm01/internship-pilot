import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

function absolute(relativePath: string): string {
  return path.isAbsolute(relativePath)
    ? relativePath
    : path.join(/* turbopackIgnore: true */ process.cwd(), relativePath);
}

function storageDirectory(): string {
  return process.env.RESUME_STORAGE_DIR ?? path.join("data", "resumes");
}

export function resumeStoragePath(documentId: string): string {
  return path.join(storageDirectory(), `${documentId}.pdf`);
}

export async function saveResumePdf(documentId: string, bytes: Uint8Array): Promise<string> {
  await mkdir(absolute(storageDirectory()), { recursive: true });
  const relativePath = resumeStoragePath(documentId);
  await writeFile(absolute(relativePath), bytes);
  return relativePath;
}

export async function deleteResumePdf(relativePath: string): Promise<void> {
  try {
    await unlink(absolute(relativePath));
  } catch {
    // Already gone — nothing to clean up.
  }
}
