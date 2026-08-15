import { isCloudRuntime } from "@/lib/runtime/deployment";
import { LocalDocumentStorage } from "@/lib/storage/local";
import { VercelBlobDocumentStorage } from "@/lib/storage/vercelBlob";
import {
  isRemoteStorageKey,
  type DocumentStorage,
  type StorageKey,
  type StorageWriteOptions,
} from "@/lib/storage/types";

export * from "@/lib/storage/types";
export { LocalDocumentStorage } from "@/lib/storage/local";
export { VercelBlobDocumentStorage } from "@/lib/storage/vercelBlob";

export type StorageDriver = "local" | "vercel-blob";

/** The backend new writes go to. Explicit setting first, runtime second. */
export function configuredDriver(): StorageDriver {
  const declared = process.env.DOCUMENT_STORAGE_DRIVER?.trim().toLowerCase();
  if (declared === "local" || declared === "vercel-blob") return declared;
  return isCloudRuntime() ? "vercel-blob" : "local";
}

let cachedWriteBackend: { driver: StorageDriver; storage: DocumentStorage } | null = null;

/** The backend that new objects are written to. */
export function writeStorage(): DocumentStorage {
  const driver = configuredDriver();
  if (cachedWriteBackend?.driver === driver) return cachedWriteBackend.storage;
  const storage: DocumentStorage =
    driver === "vercel-blob" ? new VercelBlobDocumentStorage() : new LocalDocumentStorage();
  cachedWriteBackend = { driver, storage };
  return storage;
}

/**
 * The backend that owns an existing key.
 *
 * Reads are routed by the shape of the stored identifier rather than by
 * configuration, which is the whole reason a migration does not need a
 * database rewrite: a row written before the move still carries a relative
 * path and still resolves from disk, while everything written afterwards
 * carries a blob URL. Both work in the same process, in either order.
 */
export function storageFor(key: StorageKey): DocumentStorage {
  if (isRemoteStorageKey(key)) return new VercelBlobDocumentStorage();
  return new LocalDocumentStorage();
}

/** Reads an object, choosing the backend from the key itself. */
export function readStoredObject(key: StorageKey): Promise<Uint8Array<ArrayBuffer>> {
  return storageFor(key).read(key);
}

/** Deletes an object, choosing the backend from the key itself. */
export function deleteStoredObject(key: StorageKey): Promise<void> {
  return storageFor(key).delete(key);
}

export function storedObjectExists(key: StorageKey): Promise<boolean> {
  return storageFor(key).exists(key);
}

/** Writes an object to the configured backend and returns its durable id. */
export function writeStoredObject(
  key: StorageKey,
  bytes: Uint8Array,
  options?: StorageWriteOptions,
): Promise<StorageKey> {
  return writeStorage().write(key, bytes, options);
}

/** Test seam: forget the memoized write backend after changing the env. */
export function resetStorageForTests(): void {
  cachedWriteBackend = null;
}
