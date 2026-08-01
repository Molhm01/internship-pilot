import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const readFile = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    generatedDocument: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFile(...args),
}));

import { GET } from "./route";

describe("GET /api/documents/[id]/download", () => {
  beforeEach(() => vi.resetAllMocks());

  it("serves the PDF created for a persisted document record", async () => {
    findUnique.mockResolvedValue({
      id: "resume-v2",
      type: "resume",
      version: 2,
      storagePath: "data/generated/job-1/resume-v2.pdf",
    });
    readFile.mockResolvedValue(Buffer.from("%PDF"));

    const response = await GET(new Request("http://localhost/api/documents/resume-v2/download"), {
      params: Promise.resolve({ id: "resume-v2" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="resume-v2.pdf"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(Buffer.from("%PDF")));
  });

  it("returns a readable JSON error when the stored PDF is missing", async () => {
    findUnique.mockResolvedValue({
      id: "cover-v1",
      type: "coverLetter",
      version: 1,
      storagePath: "data/generated/job-1/cover-letter-v1.pdf",
    });
    readFile.mockRejectedValue(new Error("ENOENT"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(new Request("http://localhost/api/documents/cover-v1/download"), {
      params: Promise.resolve({ id: "cover-v1" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "The generated file could not be read from disk.",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
