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
      agentDelivery: {
        resume: { delivered: true, documentId: "agent-r", documentType: "resume", filename: "Resume.pdf" },
        coverLetter: { delivered: false, documentType: "cover_letter", reason: "The agent did not answer." },
      },
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
    // The delivery result travels with the ids: the page has to be able to say
    // the résumé reached the extension and the cover letter did not.
    expect(await response.json()).toEqual({
      ok: true,
      resumeDocumentId: "resume-v2",
      coverLetterDocumentId: "cover-v2",
      agentDelivery: generated.agentDelivery,
    });
    expect(generateDocumentsForJob).toHaveBeenCalledWith("job-1", "test-user", {
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

// Route handlers authenticate through this module. The tests below call them
// directly, so a session has to exist; who it belongs to is exercised by
// src/lib/auth/multiUserIsolation.test.ts against a real database.
vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  const user = { id: "test-user", email: "test@example.test", name: "Test", image: null, emailVerified: true };
  return {
    ...actual,
    currentUser: async () => user,
    requireUser: async () => user,
    guardSession: async () => null,
    withUser:
      <C>(handler: (request: Request, sessionUser: typeof user, context: C) => Promise<Response>) =>
      async (request: Request, context: C) =>
        handler(request, user, context),
  };
});
