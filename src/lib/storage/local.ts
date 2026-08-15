import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  StorageObjectNotFoundError,
  isRemoteStorageKey,
  type DocumentStorage,
  type StorageKey,
} from "@/lib/storage/types";

/**
 * The filesystem backend — the behaviour Internship Pilot has always had,
 * now expressed as one implementation of the storage contract instead of a
 * `path.join(process.cwd(), …)` repeated at every call site.
 *
 * Keys are repository-relative POSIX-ish paths such as
 * `data/generated/<jobId>/resume-v1.pdf`. That is deliberately the exact
 * format already stored in `GeneratedDocument.storagePath`, so no row needs
 * rewriting and no compatibility shim is needed on this side.
 */
/**
 * Root every local key resolves inside. Defaults to the repository, which is
 * what the existing relative `data/...` keys have always meant. Overridable
 * so an install can keep résumés and generated PDFs on a different volume —
 * and so tests can point at a temporary directory without weakening the
 * containment check below.
 */
export function localStorageRoot(): string {
  return process.env.LOCAL_DOCUMENT_STORAGE_ROOT?.trim() || process.cwd();
}

export class LocalDocumentStorage implements DocumentStorage {
  readonly driver = "local" as const;
  private readonly root: string;

  constructor(root: string = localStorageRoot()) {
    this.root = root;
  }

  /**
   * Resolves a key inside the storage root and refuses anything that escapes
   * it. `storagePath` reaches this function from database rows, and a row is
   * not a trusted input just because this application wrote it.
   */
  private absolute(key: StorageKey): string {
    if (isRemoteStorageKey(key)) {
      throw new StorageObjectNotFoundError(key);
    }
    const resolved = path.isAbsolute(key)
      ? path.resolve(key)
      : path.resolve(this.root, key);
    const root = path.resolve(this.root);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new StorageObjectNotFoundError(key);
    }
    return resolved;
  }

  async write(key: StorageKey, bytes: Uint8Array): Promise<StorageKey> {
    const target = this.absolute(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return key;
  }

  async read(key: StorageKey): Promise<Uint8Array<ArrayBuffer>> {
    try {
      return new Uint8Array(await readFile(this.absolute(key)));
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) throw error;
      throw new StorageObjectNotFoundError(key, error);
    }
  }

  async delete(key: StorageKey): Promise<void> {
    try {
      await unlink(this.absolute(key));
    } catch {
      // Already gone, or outside the root and therefore never ours to remove.
    }
  }

  async exists(key: StorageKey): Promise<boolean> {
    try {
      return (await stat(this.absolute(key))).isFile();
    } catch {
      return false;
    }
  }
}
