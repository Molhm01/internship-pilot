import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { generatedDocument: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

const { GET } = await import("./route");

/**
 * Serving a generated PDF back to the user.
 *
 * The point of routing this through the storage abstraction is that the row
 * decides where its bytes live. A `storagePath` written before the move to
 * object storage is still a relative path and must still be served from disk;
 * one written afterwards is a blob URL. Both have to work in the same process,
 * because that is what a deployment looks like on the day it happens.
 */

const PDF = Buffer.from("%PDF-1.7\ntailored\n%%EOF\n");

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "download-"));
  process.env.LOCAL_DOCUMENT_STORAGE_ROOT = root;
  await writeFile(path.join(root, "resume-v4.pdf"), PDF);
});

afterAll(async () => {
  delete process.env.LOCAL_DOCUMENT_STORAGE_ROOT;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => vi.clearAllMocks());

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/documents/[id]/download", () => {
  it("serves a document stored as a local path", async () => {
    findUnique.mockResolvedValue({
      id: "doc-1",
      type: "resume",
      version: 4,
      storagePath: "resume-v4.pdf",
    });

    const response = await GET(new Request("http://test/api/documents/doc-1/download"), params("doc-1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain("resume-v4.pdf");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF);
  });

  it("does not open a path that escapes the storage root", async () => {
    findUnique.mockResolvedValue({
      id: "doc-2",
      type: "resume",
      version: 1,
      storagePath: "../../../etc/passwd",
    });

    const response = await GET(new Request("http://test/api/documents/doc-2/download"), params("doc-2"));

    expect(response.status).toBe(404);
  });

  it("reports a missing object instead of serving an empty PDF", async () => {
    findUnique.mockResolvedValue({
      id: "doc-3",
      type: "coverLetter",
      version: 2,
      storagePath: "cover-letter-v2.pdf",
    });

    const response = await GET(new Request("http://test/api/documents/doc-3/download"), params("doc-3"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "The generated file could not be read from storage.",
    });
  });

  it("404s an unknown document without touching storage", async () => {
    findUnique.mockResolvedValue(null);

    const response = await GET(new Request("http://test/api/documents/nope/download"), params("nope"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Document not found" });
  });
});
