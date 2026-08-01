import { describe, expect, it, vi } from "vitest";
import {
  DocumentRequestError,
  fetchDocumentPdf,
  fetchJobDocuments,
  generateTailoredDocuments,
} from "./client";

describe("tailored-document client workflow", () => {
  it("loads every saved version from the canonical job document endpoint", async () => {
    const documents = [
      { id: "resume-v2", type: "resume", version: 2 },
      { id: "resume-v1", type: "resume", version: 1 },
      { id: "cover-v2", type: "coverLetter", version: 2 },
      { id: "cover-v1", type: "coverLetter", version: 1 },
    ];
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(fetchJobDocuments("job-1", fetcher)).resolves.toEqual(documents);
    expect(fetcher).toHaveBeenCalledWith("/api/jobs/job-1/documents");
  });

  it("posts one resume-and-cover-letter generation request", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      resume: { id: "resume-v1" },
      coverLetter: { id: "cover-v1" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(generateTailoredDocuments("job-1", fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("/api/jobs/job-1/generate-documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeCoverLetter: true }),
    });
  });

  it("turns generation and missing-file failures into inline-safe errors", async () => {
    const generationFetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Resume generation failed QA." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ));
    const downloadFetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "The generated file could not be read from disk." }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    ));

    await expect(generateTailoredDocuments("job-1", generationFetch)).rejects.toEqual(
      new DocumentRequestError("Resume generation failed QA."),
    );
    await expect(fetchDocumentPdf("missing-doc", downloadFetch)).rejects.toEqual(
      new DocumentRequestError("The generated file could not be read from disk."),
    );
  });

  it("accepts only a real PDF response for Open PDF", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    }));

    const pdf = await fetchDocumentPdf("resume-v1", fetcher);
    expect(pdf.type).toBe("application/pdf");
    expect(pdf.size).toBe(4);
  });
});
