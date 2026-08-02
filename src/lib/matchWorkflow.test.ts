import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasUsableJobDescription,
  manualMatchToImmediateDisplay,
  MIN_MATCH_DESCRIPTION_CHARS,
  MatchRequestError,
  matchJobDescriptionText,
  requestManualMatch,
  runManualMatchAndRefresh,
} from "./matchWorkflow";

const canonicalMatch = {
  eligibility: "PASS" as const,
  score: 87,
  reasoning: "Python is supported by approved evidence.",
  matchingQualifications: ["Python"],
  missingQualifications: ["Embedded C"],
  skillsToLearn: ["Rust"],
  neverClaim: ["Civil Engineering degree"],
};

describe("manual AI Match browser workflow", () => {
  afterEach(() => vi.useRealTimers());

  it("enables matching only when a usable job description exists", () => {
    const enoughDescription = "Build embedded systems, test firmware, document results, and collaborate with electrical engineers. ".repeat(2);
    expect(enoughDescription.length).toBeGreaterThanOrEqual(MIN_MATCH_DESCRIPTION_CHARS);
    expect(hasUsableJobDescription(enoughDescription)).toBe(true);
    expect(hasUsableJobDescription("Build embedded systems and test firmware.")).toBe(false);
    expect(hasUsableJobDescription("   ")).toBe(false);
    expect(hasUsableJobDescription("No description available")).toBe(false);
  });

  it("uses stored responsibilities and qualifications as job-description evidence", () => {
    const source = {
      description: "Firmware internship.",
      jobResponsibilities: JSON.stringify([
        "Build and test embedded firmware for production devices.",
        "Document verification results and collaborate with hardware engineers.",
      ]),
      jobQualifications: JSON.stringify([
        "Experience with Python or C++ and digital communication protocols.",
      ]),
    };

    expect(matchJobDescriptionText(source)).toContain("Responsibilities:");
    expect(matchJobDescriptionText(source)).toContain("Qualifications:");
    expect(hasUsableJobDescription(source)).toBe(true);
  });

  it("posts the selected job and returns the persisted result", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, match: canonicalMatch })) as unknown as typeof fetch;

    await expect(requestManualMatch("job-42", fetcher)).resolves.toEqual(canonicalMatch);
    expect(fetcher).toHaveBeenCalledWith("/api/match", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "job-42" }),
      signal: expect.any(AbortSignal),
    }));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("turns a model failure into an inline-safe error message", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { ok: false, error: "MODEL_UNAVAILABLE", message: "The local AI model failed. Try again." },
      { status: 503 },
    )) as unknown as typeof fetch;

    await expect(requestManualMatch("job-42", fetcher)).rejects.toEqual(
      new MatchRequestError("The local AI model failed. Try again.", "MODEL_UNAVAILABLE"),
    );
  });

  it("clears job-scoped loading after failure", async () => {
    const loading: Record<string, boolean> = { "other-job": true };
    const fetcher = vi.fn(async () => Response.json(
      { ok: false, error: "MODEL_RESPONSE_INVALID", message: "The model response was invalid." },
      { status: 502 },
    )) as unknown as typeof fetch;

    await expect(runManualMatchAndRefresh({
      jobId: "job-failed",
      fetcher,
      onLoadingChange(jobId, active) { loading[jobId] = active; },
      refreshMatch: vi.fn(),
    })).rejects.toThrow("model response was invalid");
    expect(loading).toEqual({ "other-job": true, "job-failed": false });
  });

  it("times out, clears only the current job, and does not refresh", async () => {
    vi.useFakeTimers();
    const loading: Record<string, boolean> = { "other-job": true };
    const refreshMatch = vi.fn();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;
    const request = runManualMatchAndRefresh({
      jobId: "job-timeout",
      fetcher,
      timeoutMs: 25,
      onLoadingChange(jobId, active) { loading[jobId] = active; },
      refreshMatch,
    });

    const expectation = expect(request).rejects.toMatchObject({ code: "MATCH_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
    expect(loading).toEqual({ "other-job": true, "job-timeout": false });
    expect(refreshMatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("refreshes the displayed match after a successful request", async () => {
    const refreshMatch = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(async () => Response.json({ ok: true, match: canonicalMatch })) as unknown as typeof fetch;

    await runManualMatchAndRefresh({
      jobId: "job-success",
      fetcher,
      onLoadingChange: vi.fn(),
      refreshMatch,
    });

    expect(refreshMatch).toHaveBeenCalledWith("job-success");
  });

  it("renders the returned result and clears loading before a non-blocking refresh", async () => {
    const events: string[] = [];
    const fetcher = vi.fn(async () => Response.json({ ok: true, match: canonicalMatch })) as unknown as typeof fetch;
    const refreshMatch = vi.fn(() => new Promise<void>(() => undefined));

    await expect(runManualMatchAndRefresh({
      jobId: "job-success",
      fetcher,
      onLoadingChange: (_jobId, active) => events.push(`loading:${active}`),
      onResult: (_jobId, result) => events.push(`result:${result.score}`),
      refreshMatch,
    })).resolves.toEqual(canonicalMatch);

    expect(events).toEqual(["loading:true", "result:87", "loading:false"]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(refreshMatch).toHaveBeenCalledOnce();
  });

  it("maps a completed response to an immediate local display without waiting for reload", () => {
    const display = manualMatchToImmediateDisplay(
      canonicalMatch,
      new Date("2026-08-01T12:00:00.000Z"),
    );

    expect(display).toMatchObject({
      eligibility: "Pass",
      score: 87,
      eligibilityReason: canonicalMatch.reasoning,
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    expect(JSON.parse(display.skillsSupported)).toEqual([
      expect.objectContaining({ skill: "Python" }),
    ]);
  });

  it("clears loading even when the post-match refresh fails", async () => {
    const events: string[] = [];
    const onRefreshError = vi.fn();
    const fetcher = vi.fn(async () => Response.json({ ok: true, match: canonicalMatch })) as unknown as typeof fetch;

    await runManualMatchAndRefresh({
      jobId: "job-refresh-failed",
      fetcher,
      onLoadingChange: (_jobId, active) => events.push(`loading:${active}`),
      refreshMatch: vi.fn().mockRejectedValue(new Error("refresh failed")),
      onRefreshError,
    });
    await Promise.resolve();

    expect(events).toEqual(["loading:true", "loading:false"]);
    expect(onRefreshError).toHaveBeenCalledWith("job-refresh-failed", expect.any(Error));
  });

  it("normalizes an unreadable failure instead of leaking a runtime exception", async () => {
    const fetcher = vi.fn(async () => new Response("not json", { status: 502 })) as unknown as typeof fetch;

    await expect(requestManualMatch("job-42", fetcher)).rejects.toEqual(
      new MatchRequestError("AI Match failed without returning a readable error.", "MATCH_RESPONSE_UNREADABLE"),
    );
  });
});
