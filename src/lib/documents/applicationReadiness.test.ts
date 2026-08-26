import { describe, expect, it, vi, beforeEach } from "vitest";

const findManyMock = vi.fn();
const generateDocumentsForJobMock = vi.fn();
const computeDocumentFingerprintMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    generatedDocument: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

vi.mock("./generate", () => ({
  generateDocumentsForJob: (...args: unknown[]) => generateDocumentsForJobMock(...args),
}));

vi.mock("./documentFingerprint", () => ({
  computeDocumentFingerprint: (...args: unknown[]) => computeDocumentFingerprintMock(...args),
}));

// Imported after the mocks above so the module under test picks them up.
const { ensureApplicationDocuments } = await import("./applicationReadiness");

function pendingGeneration() {
  let resolve!: (value: { resume: { id: string }; coverLetter: null }) => void;
  const promise = new Promise<{ resume: { id: string }; coverLetter: null }>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("ensureApplicationDocuments concurrency coalescing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("coalesces concurrent calls for the SAME user+job into exactly one generation attempt", async () => {
    computeDocumentFingerprintMock.mockResolvedValue("fp-1");
    // No reusable document on the initial lookup: every caller sees a stale/missing document.
    findManyMock.mockResolvedValueOnce([]);
    const { promise: generation, resolve: resolveGeneration } = pendingGeneration();
    generateDocumentsForJobMock.mockReturnValueOnce(generation);
    // Post-generation lookup, shared by every coalesced caller.
    findManyMock.mockResolvedValueOnce([
      { id: "resume-1", type: "resume", version: 1, qaStatus: "pass", identityVerified: true },
    ]);

    const calls = Array.from({ length: 5 }, () =>
      ensureApplicationDocuments("job-1", "user-1", { includeCoverLetter: false }),
    );
    // Let the five callers race up to the point where they'd each decide
    // whether to start their own generation, before the single in-flight
    // generation resolves.
    await Promise.resolve();
    await Promise.resolve();
    resolveGeneration({ resume: { id: "resume-1" }, coverLetter: null });

    const results = await Promise.all(calls);

    expect(generateDocumentsForJobMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.documents[0].id).toBe("resume-1");
      expect(result.reused).toBe(false);
    }
  });

  it("does not share in-flight state across different jobs or different users", async () => {
    computeDocumentFingerprintMock.mockResolvedValue("fp-shared");
    generateDocumentsForJobMock.mockResolvedValue({ resume: { id: "resume-fresh" }, coverLetter: null });
    findManyMock.mockImplementation(async (args: { where: { jobId: string; userId: string; documentFingerprint?: string } }) =>
      args.where.jobId === "job-1" && args.where.userId === "user-1" && args.where.documentFingerprint
        ? [{ id: "resume-existing", type: "resume", version: 1, qaStatus: "pass", identityVerified: true, jobId: "job-1", userId: "user-1", documentFingerprint: "fp-shared" }]
        : [{ id: "resume-fresh", type: "resume", version: 1, qaStatus: "pass", identityVerified: true }],
    );

    await Promise.all([
      ensureApplicationDocuments("job-1", "user-1", { includeCoverLetter: false }),
      ensureApplicationDocuments("job-2", "user-1", { includeCoverLetter: false }),
      ensureApplicationDocuments("job-1", "user-2", { includeCoverLetter: false }),
    ]);

    // Each distinct user+job key issued its own fingerprint lookup — none of
    // these three were coalesced with each other.
    expect(computeDocumentFingerprintMock).toHaveBeenCalledTimes(3);
  });

  it("clears the in-flight entry after settling, so a later call starts its own attempt", async () => {
    computeDocumentFingerprintMock.mockResolvedValue("fp-2");
    findManyMock.mockResolvedValue([
      { id: "resume-2", type: "resume", version: 1, qaStatus: "pass", identityVerified: true, jobId: "job-1", userId: "user-1", documentFingerprint: "fp-2" },
    ]);

    await ensureApplicationDocuments("job-1", "user-1", { includeCoverLetter: false });
    await ensureApplicationDocuments("job-1", "user-1", { includeCoverLetter: false });

    expect(computeDocumentFingerprintMock).toHaveBeenCalledTimes(2);
  });
});
