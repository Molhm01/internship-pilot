import { describe, expect, it, vi } from "vitest";
import {
  DocumentRequestError,
  fetchDocumentPdf,
  fetchJobDocuments,
  generateTailoredDocuments,
  runTailoredDocumentGeneration,
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
      ok: true,
      resumeDocumentId: "resume-v1",
      coverLetterDocumentId: "cover-v1",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(generateTailoredDocuments("job-1", fetcher)).resolves.toEqual({
      ok: true,
      resumeDocumentId: "resume-v1",
      coverLetterDocumentId: "cover-v1",
    });
    expect(fetcher).toHaveBeenCalledWith("/api/jobs/job-1/generate-documents", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeCoverLetter: true }),
      signal: expect.any(AbortSignal),
    }));
  });

  it("clears per-job loading and refreshes saved documents after success", async () => {
    const loading: Record<string, boolean> = {};
    const events: Array<[string, boolean]> = [];
    const refreshDocuments = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      resumeDocumentId: "resume-v1",
      coverLetterDocumentId: "cover-v1",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await runTailoredDocumentGeneration({
      jobId: "job-1",
      fetcher,
      onLoadingChange(jobId, active) {
        loading[jobId] = active;
        events.push([jobId, active]);
      },
      refreshDocuments,
    });

    expect(events).toEqual([["job-1", true], ["job-1", false]]);
    expect(loading["job-1"]).toBe(false);
    expect(refreshDocuments).toHaveBeenCalledWith("job-1");
  });

  it("clears loading after a structured generation failure", async () => {
    const events: Array<[string, boolean]> = [];
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: "Cover letter persistence failed. Existing document versions were kept.",
    }), { status: 500, headers: { "Content-Type": "application/json" } }));

    await expect(runTailoredDocumentGeneration({
      jobId: "job-failed",
      fetcher,
      onLoadingChange: (jobId, active) => events.push([jobId, active]),
      refreshDocuments: vi.fn(),
    })).rejects.toThrow("Cover letter persistence failed");
    expect(events).toEqual([["job-failed", true], ["job-failed", false]]);
  });

  it("aborts a timed-out request and clears only that job's loading state", async () => {
    vi.useFakeTimers();
    const loading: Record<string, boolean> = {};
    const pendingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const request = runTailoredDocumentGeneration({
      jobId: "job-timeout",
      fetcher: pendingFetch as typeof fetch,
      timeoutMs: 25,
      onLoadingChange(jobId, active) { loading[jobId] = active; },
      refreshDocuments: vi.fn(),
    });
    loading["other-job"] = true;

    const expectation = expect(request).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
    expect(loading).toEqual({ "job-timeout": false, "other-job": true });
    vi.useRealTimers();
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
