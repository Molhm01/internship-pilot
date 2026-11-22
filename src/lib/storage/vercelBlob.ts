import {
  StorageNotConfiguredError,
  StorageObjectNotFoundError,
  isRemoteStorageKey,
  type DocumentStorage,
  type StorageKey,
  type StorageWriteOptions,
} from "@/lib/storage/types";

// MOCKED — in-memory @vercel/blob stub (data lost on container sleep)
const globalForBlobMock = globalThis as unknown as {
  mockBlobStore: Map<string, Uint8Array<ArrayBuffer>> | undefined;
};
const mockBlobStore =
  globalForBlobMock.mockBlobStore ?? new Map<string, Uint8Array<ArrayBuffer>>();
globalForBlobMock.mockBlobStore = mockBlobStore;

/**
 * Vercel Blob — mocked with an in-memory Map stub in AI Studio.
 *
 * Access is `private`. Keeps the exact contract and pathname mapping so
 * storage routing and unit tests continue to work identically.
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
    return { token: this.token, access: "private" as const };
  }

  async write(
    key: StorageKey,
    bytes: Uint8Array,
    options: StorageWriteOptions = {},
  ): Promise<StorageKey> {
    void options;
    this.options();
    const pathname = pathnameFor(key);
    const url = `https://mock.blob.vercel-storage.com/${pathname}`;
    mockBlobStore.set(pathname, new Uint8Array(bytes));
    mockBlobStore.set(url, new Uint8Array(bytes));
    return url;
  }

  async read(key: StorageKey): Promise<Uint8Array<ArrayBuffer>> {
    this.options();
    const found = mockBlobStore.get(key) ?? mockBlobStore.get(pathnameFor(key));
    if (!found) {
      throw new StorageObjectNotFoundError(key);
    }
    return new Uint8Array(found);
  }

  async delete(key: StorageKey): Promise<void> {
    this.options();
    mockBlobStore.delete(key);
    mockBlobStore.delete(pathnameFor(key));
  }

  async exists(key: StorageKey): Promise<boolean> {
    this.options();
    return mockBlobStore.has(key) || mockBlobStore.has(pathnameFor(key));
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
