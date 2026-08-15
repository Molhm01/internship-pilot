/**
 * Where Internship Pilot's binary artefacts live.
 *
 * Every generated PDF, uploaded résumé, and application screenshot used to be
 * addressed as a path relative to `process.cwd()` and read with `readFile`.
 * That is exactly right on a laptop and completely wrong on Vercel: a
 * serverless filesystem is read-only apart from `/tmp`, and `/tmp` belongs to
 * one invocation. A résumé written during the upload request is simply not
 * there when the download request arrives, and no error appears until a user
 * clicks a document that has silently ceased to exist.
 *
 * So file access goes through one interface with two implementations, and the
 * rest of the application never names a provider.
 */

/**
 * A durable, opaque handle to one stored object.
 *
 * Local storage returns the repository-relative path it has always used, so
 * every `GeneratedDocument.storagePath` and `ResumeDocument.storagePath`
 * already in the database keeps working untouched. Object storage returns an
 * absolute blob URL. Both are self-describing, which is what lets a single
 * install read rows written before and after a migration.
 */
export type StorageKey = string;

export type StorageWriteOptions = {
  /** MIME type, stored alongside the object where the backend supports it. */
  contentType?: string;
};

export interface DocumentStorage {
  /** Backend name, for diagnostics and tests. */
  readonly driver: "local" | "vercel-blob";

  /**
   * Stores `bytes` under `key` and returns the durable identifier to persist.
   * The returned value may differ from `key` — never assume they are equal.
   */
  write(key: StorageKey, bytes: Uint8Array, options?: StorageWriteOptions): Promise<StorageKey>;

  /**
   * Reads an object back. Throws `StorageObjectNotFoundError` when absent.
   *
   * The `ArrayBuffer` type argument is not incidental: `Response`/`NextResponse`
   * accept a `Uint8Array<ArrayBuffer>` as a body but not the wider
   * `Uint8Array<ArrayBufferLike>`, and every caller here is a download route.
   */
  read(key: StorageKey): Promise<Uint8Array<ArrayBuffer>>;

  /** Removes an object. Succeeds when the object was already gone. */
  delete(key: StorageKey): Promise<void>;

  exists(key: StorageKey): Promise<boolean>;
}

export class StorageObjectNotFoundError extends Error {
  readonly code = "STORAGE_OBJECT_NOT_FOUND";

  constructor(key: StorageKey, cause?: unknown) {
    super(`No stored object for "${key}".`);
    this.name = "StorageObjectNotFoundError";
    this.cause = cause;
  }
}

export class StorageNotConfiguredError extends Error {
  readonly code = "STORAGE_NOT_CONFIGURED";

  constructor(message: string) {
    super(message);
    this.name = "StorageNotConfiguredError";
  }
}

/** True when a stored identifier is an absolute object-storage URL. */
export function isRemoteStorageKey(key: StorageKey): boolean {
  return /^https?:\/\//i.test(key.trim());
}
