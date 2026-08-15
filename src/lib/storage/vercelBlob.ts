import { del, get, head, put } from "@vercel/blob";
import {
  StorageNotConfiguredError,
  StorageObjectNotFoundError,
  isRemoteStorageKey,
  type DocumentStorage,
  type StorageKey,
  type StorageWriteOptions,
} from "@/lib/storage/types";

/**
 * Vercel Blob — the production backend.
 *
 * Access is `private`. These objects are tailored résumés, cover letters, and
 * screenshots of half-filled application forms: they contain the user's name,
 * address, phone number, and employment history. A public blob URL is an
 * unauthenticated, unguessable-but-permanent link to that, so every read goes
 * through the SDK with the store token instead.
 *
 * `write` returns the blob URL rather than the pathname it was given, and that
 * URL is what gets stored on the row. A URL identifies the object without any
 * ambiguity about which store or deployment produced it, and it is what lets
 * `documentStorage()` route each individual row to the right backend during a
 * migration — local paths keep resolving locally while new writes land here.
 */
export class VercelBlobDocumentStorage implements DocumentStorage {
  readonly driver = "vercel-blob" as const;

  constructor(private readonly token: string | undefined = process.env.BLOB_READ_WRITE_TOKEN) {}

  private options() {
    if (!this.token) {
      throw new StorageNotConfiguredError(
        "BLOB_READ_WRITE_TOKEN is not set. Create a Blob store in the Vercel dashboard and connect it to this project.",
      );
    }
    return { token: this.token } as const;
  }

  async write(
    key: StorageKey,
    bytes: Uint8Array,
    options: StorageWriteOptions = {},
  ): Promise<StorageKey> {
    const result = await put(pathnameFor(key), Buffer.from(bytes), {
      ...this.options(),
      access: "private",
      // The pathname is derived from ids the application controls, and a
      // regenerated document version deliberately replaces its predecessor.
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(options.contentType ? { contentType: options.contentType } : {}),
    });
    return result.url;
  }

  async read(key: StorageKey): Promise<Uint8Array<ArrayBuffer>> {
    let result;
    try {
      result = await get(key, { ...this.options(), access: "private" });
    } catch (error) {
      throw new StorageObjectNotFoundError(key, error);
    }
    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new StorageObjectNotFoundError(key);
    }
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  }

  async delete(key: StorageKey): Promise<void> {
    try {
      await del(key, this.options());
    } catch {
      // Deleting something already absent is the outcome the caller wanted.
    }
  }

  async exists(key: StorageKey): Promise<boolean> {
    try {
      return Boolean(await head(key, this.options()));
    } catch {
      return false;
    }
  }
}

/**
 * Blob pathnames are flat strings, so a repository-relative key maps over
 * directly once Windows separators are normalized. A key that is already a
 * blob URL is passed through so a rewrite of an existing object keeps its
 * identity.
 */
export function pathnameFor(key: StorageKey): string {
  if (isRemoteStorageKey(key)) return new URL(key).pathname.replace(/^\/+/, "");
  return key.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
