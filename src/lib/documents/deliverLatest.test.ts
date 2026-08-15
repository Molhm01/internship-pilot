import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    generatedDocument: { findFirst: (...args: unknown[]) => findFirst(...args) },
    job: { findUnique: (...args: unknown[]) => findUnique(...args) },
  },
}));

const { NoStoredDocumentsError, deliverLatestDocumentsForJob } = await import("./deliverLatest");

/**
 * Re-sending already-generated documents. The point of this path is that a
 * transport failure can be retried without paying for compilation again, so what
 * matters is that it reads the same stored bytes and reports each document's
 * outcome on its own.
 */

const RESUME_BYTES = Buffer.from("%PDF-1.4\nresume\n%%EOF\n");
const COVER_BYTES = Buffer.from("%PDF-1.4\ncover letter\n%%EOF\n");

let directory: string;
let resumePath: string;
let coverPath: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "deliver-latest-"));
  // Local storage confines every key inside one root, so a stored path that
  // escapes it reads as "missing" rather than being opened. The fixtures live
  // outside the repository, so the root is pointed at them for this suite.
  process.env.LOCAL_DOCUMENT_STORAGE_ROOT = directory;
  resumePath = path.join(directory, "resume-v3.pdf");
  coverPath = path.join(directory, "cover-letter-v3.pdf");
  await writeFile(resumePath, RESUME_BYTES);
  await writeFile(coverPath, COVER_BYTES);
});

afterAll(async () => {
  delete process.env.LOCAL_DOCUMENT_STORAGE_ROOT;
  await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ company: "Acme", title: "Software Engineering Intern" });
});

function storedDocument(storagePath: string) {
  return { storagePath, createdAt: new Date("2026-08-05T12:00:00.000Z"), version: 3 };
}

describe("re-sending the latest stored documents", () => {
  it("sends the newest QA-passed PDF of each type with its real bytes", async () => {
    findFirst.mockImplementation(({ where }: { where: { type: string } }) =>
      Promise.resolve(storedDocument(where.type === "resume" ? resumePath : coverPath)),
    );
    const deliver = vi.fn().mockImplementation(({ documentType }) =>
      Promise.resolve({ delivered: true, documentId: `id-${documentType}`, documentType, filename: "f.pdf" }),
    );

    const report = await deliverLatestDocumentsForJob("job-1", "test-user", deliver);

    expect(report.resume).toEqual({
      delivered: true, documentId: "id-resume", documentType: "resume", filename: "f.pdf",
    });
    expect(report.coverLetter).toEqual({
      delivered: true, documentId: "id-cover_letter", documentType: "cover_letter", filename: "f.pdf",
    });

    // An archived or failed version must never be offered to an employer.
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ qaStatus: "pass" }),
      orderBy: { version: "desc" },
    }));

    const [resumeCall] = deliver.mock.calls[0] as [{ bytes: Uint8Array; documentType: string; company: string }];
    expect(Buffer.from(resumeCall.bytes)).toEqual(RESUME_BYTES);
    expect(resumeCall.documentType).toBe("resume");
    expect(resumeCall.company).toBe("Acme");
    const [coverCall] = deliver.mock.calls[1] as [{ bytes: Uint8Array }];
    expect(Buffer.from(coverCall.bytes)).toEqual(COVER_BYTES);
  });

  it("reports each document separately when only one send fails", async () => {
    findFirst.mockImplementation(({ where }: { where: { type: string } }) =>
      Promise.resolve(storedDocument(where.type === "resume" ? resumePath : coverPath)),
    );
    const deliver = vi.fn()
      .mockResolvedValueOnce({ delivered: false, documentType: "resume", reason: "The agent refused it." })
      .mockResolvedValueOnce({ delivered: true, documentId: "id-c", documentType: "cover_letter", filename: "c.pdf" });

    const report = await deliverLatestDocumentsForJob("job-1", "test-user", deliver);

    expect(report.resume).toMatchObject({ delivered: false });
    expect(report.coverLetter).toMatchObject({ delivered: true });
  });

  it("delivers the résumé when no cover letter was generated", async () => {
    findFirst.mockImplementation(({ where }: { where: { type: string } }) =>
      Promise.resolve(where.type === "resume" ? storedDocument(resumePath) : null),
    );
    const deliver = vi.fn().mockResolvedValue({
      delivered: true, documentId: "id-r", documentType: "resume", filename: "r.pdf",
    });

    const report = await deliverLatestDocumentsForJob("job-1", "test-user", deliver);

    expect(report.resume).toMatchObject({ delivered: true });
    expect(report.coverLetter).toBeNull();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("reports a missing file as a delivery failure rather than sending nothing", async () => {
    findFirst.mockImplementation(({ where }: { where: { type: string } }) =>
      Promise.resolve(where.type === "resume"
        ? storedDocument(path.join(directory, "deleted.pdf"))
        : null),
    );
    const deliver = vi.fn();

    const report = await deliverLatestDocumentsForJob("job-1", "test-user", deliver);

    expect(report.resume).toMatchObject({ delivered: false });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses when the job has no generated documents at all", async () => {
    findFirst.mockResolvedValue(null);

    await expect(deliverLatestDocumentsForJob("job-1", "test-user", vi.fn()))
      .rejects.toBeInstanceOf(NoStoredDocumentsError);
  });
});
