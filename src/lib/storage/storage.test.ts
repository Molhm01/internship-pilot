import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalDocumentStorage } from "./local";
import { VercelBlobDocumentStorage, pathnameFor } from "./vercelBlob";
import { StorageObjectNotFoundError, isRemoteStorageKey } from "./types";
import { configuredDriver, resetStorageForTests, storageFor, writeStorage } from "./index";

/**
 * The storage abstraction.
 *
 * Two properties matter more than the individual methods. First, a stored
 * identifier is self-describing, so a database written before the move to
 * object storage still resolves afterwards without a migration. Second, local
 * keys are confined to one root — `storagePath` arrives from a database row,
 * and a row is not a trusted path just because this application wrote it.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "storage-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const SAVED = {
  driver: process.env.DOCUMENT_STORAGE_DRIVER,
  runtime: process.env.INTERNSHIP_PILOT_RUNTIME,
};

afterEach(() => {
  delete process.env.DOCUMENT_STORAGE_DRIVER;
  delete process.env.INTERNSHIP_PILOT_RUNTIME;
  if (SAVED.driver !== undefined) process.env.DOCUMENT_STORAGE_DRIVER = SAVED.driver;
  if (SAVED.runtime !== undefined) process.env.INTERNSHIP_PILOT_RUNTIME = SAVED.runtime;
  resetStorageForTests();
});

describe("local storage", () => {
  it("round-trips bytes and returns the key it was given", async () => {
    const storage = new LocalDocumentStorage(root);
    const bytes = new Uint8Array([37, 80, 68, 70]); // "%PDF"

    const key = await storage.write("data/generated/job-1/resume-v1.pdf", bytes);

    expect(key).toBe("data/generated/job-1/resume-v1.pdf");
    expect(await storage.read(key)).toEqual(bytes);
    expect(await storage.exists(key)).toBe(true);
  });

  it("creates missing parent directories", async () => {
    const storage = new LocalDocumentStorage(root);

    await storage.write("data/generated/deeply/nested/cover-letter-v2.pdf", new Uint8Array([1]));

    expect(
      await readFile(path.join(root, "data/generated/deeply/nested/cover-letter-v2.pdf")),
    ).toHaveLength(1);
  });

  it("reports a missing object rather than returning empty bytes", async () => {
    const storage = new LocalDocumentStorage(root);

    await expect(storage.read("data/generated/never-written.pdf")).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
    expect(await storage.exists("data/generated/never-written.pdf")).toBe(false);
  });

  it("refuses a key that escapes the storage root", async () => {
    const outside = path.join(root, "..", "outside-secret.pdf");
    await writeFile(outside, "secret");
    const storage = new LocalDocumentStorage(root);

    try {
      await expect(storage.read("../outside-secret.pdf")).rejects.toBeInstanceOf(
        StorageObjectNotFoundError,
      );
      await expect(storage.read(outside)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
      // A refused delete must also leave the file alone.
      await storage.delete("../outside-secret.pdf");
      expect(await readFile(outside, "utf8")).toBe("secret");
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("treats deleting an absent object as success", async () => {
    const storage = new LocalDocumentStorage(root);

    await expect(storage.delete("data/generated/absent.pdf")).resolves.toBeUndefined();
  });
});

describe("the production adapter", () => {
  it("refuses to write without a configured store instead of silently dropping bytes", async () => {
    const storage = new VercelBlobDocumentStorage(undefined);

    await expect(storage.write("data/generated/a.pdf", new Uint8Array([1]))).rejects.toThrow(
      /BLOB_READ_WRITE_TOKEN/,
    );
  });

  it("maps a repository key onto a blob pathname, separators and all", () => {
    expect(pathnameFor("data/generated/job-1/resume-v1.pdf")).toBe(
      "data/generated/job-1/resume-v1.pdf",
    );
    expect(pathnameFor("data\\generated\\job-1\\resume-v1.pdf")).toBe(
      "data/generated/job-1/resume-v1.pdf",
    );
    expect(pathnameFor("./data/generated/a.pdf")).toBe("data/generated/a.pdf");
  });

  it("keeps a blob URL's identity when rewriting it", () => {
    expect(pathnameFor("https://store.public.blob.vercel-storage.com/data/generated/a.pdf")).toBe(
      "data/generated/a.pdf",
    );
  });

  it("stores documents privately, because they are the user's résumé", async () => {
    // The access level is not a detail: a public blob URL is a permanent,
    // unauthenticated link to a document containing the user's name, address,
    // phone number, and employment history.
    const source = await readFile(new URL("./vercelBlob.ts", import.meta.url), "utf8");

    expect(source).toContain('access: "private"');
    expect(source).not.toContain('access: "public"');
  });
});

describe("choosing a backend", () => {
  it("defaults to the filesystem locally and object storage in the cloud", () => {
    // This asserts the *default*, so the explicit setting has to be absent.
    // The publish-readiness workflow exports DOCUMENT_STORAGE_DRIVER=local for
    // every job, which silently turned this into a second copy of the override
    // test below — and then failed, because the override is what it proved.
    delete process.env.DOCUMENT_STORAGE_DRIVER;
    resetStorageForTests();

    process.env.INTERNSHIP_PILOT_RUNTIME = "local";
    expect(configuredDriver()).toBe("local");

    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";
    resetStorageForTests();
    expect(configuredDriver()).toBe("vercel-blob");
    expect(writeStorage().driver).toBe("vercel-blob");
  });

  it("lets an explicit setting override the runtime default", () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";
    process.env.DOCUMENT_STORAGE_DRIVER = "local";

    expect(configuredDriver()).toBe("local");
  });

  it("routes reads by the stored identifier, not by configuration", () => {
    // This is what makes the migration a no-op for existing rows: a relative
    // path written months ago still resolves from disk while everything new
    // lands in object storage, in the same process.
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";

    expect(storageFor("data/generated/job-1/resume-v1.pdf").driver).toBe("local");
    expect(
      storageFor("https://store.public.blob.vercel-storage.com/data/generated/a.pdf").driver,
    ).toBe("vercel-blob");
  });

  it("recognizes remote identifiers and only those", () => {
    expect(isRemoteStorageKey("https://store.blob.vercel-storage.com/a.pdf")).toBe(true);
    expect(isRemoteStorageKey("http://store.example/a.pdf")).toBe(true);
    expect(isRemoteStorageKey("data/generated/a.pdf")).toBe(false);
    expect(isRemoteStorageKey("C:\\data\\generated\\a.pdf")).toBe(false);
  });
});
