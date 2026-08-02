import { beforeEach, describe, expect, it, vi } from "vitest";

const generateDocumentsForJob = vi.fn();

vi.mock("@/lib/documents/generate", () => ({
  DocumentGenerationError: class DocumentGenerationError extends Error {
    stage = "validation";
  },
  generateDocumentsForJob: (...args: unknown[]) => generateDocumentsForJob(...args),
}));

describe("POST /api/jobs/[id]/generate-documents", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the persisted resume and cover-letter records", async () => {
    const generated = {
      resume: { id: "resume-v2", type: "resume", version: 2, qaStatus: "pass" },
      coverLetter: { id: "cover-v2", type: "coverLetter", version: 2, qaStatus: "pass" },
    };
    generateDocumentsForJob.mockResolvedValue(generated);
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/jobs/job-1/generate-documents", {
        method: "POST",
        body: JSON.stringify({ includeCoverLetter: true }),
      }),
      { params: Promise.resolve({ id: "job-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      resumeDocumentId: "resume-v2",
      coverLetterDocumentId: "cover-v2",
    });
    expect(generateDocumentsForJob).toHaveBeenCalledWith("job-1", {
      includeCoverLetter: true,
    });
  });

  it("returns generation failures as JSON for inline rendering", async () => {
    const { DocumentGenerationError } = await import("@/lib/documents/generate");
    generateDocumentsForJob.mockRejectedValue(
      new DocumentGenerationError("No approved profile facts are available."),
    );
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/jobs/job-1/generate-documents", { method: "POST" }),
      { params: Promise.resolve({ id: "job-1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "No approved profile facts are available.",
    });
  });

  it("does not report success when document persistence fails", async () => {
    generateDocumentsForJob.mockRejectedValue(new Error("database unavailable"));
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/jobs/job-1/generate-documents", { method: "POST" }),
      { params: Promise.resolve({ id: "job-1" }) },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Document generation failed unexpectedly. Existing versions were kept.",
    });
  });
});
