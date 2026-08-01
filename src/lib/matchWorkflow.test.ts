import { describe, expect, it, vi } from "vitest";
import {
  hasUsableJobDescription,
  MatchRequestError,
  requestManualMatch,
} from "./matchWorkflow";

describe("manual AI Match browser workflow", () => {
  it("enables matching only when a usable job description exists", () => {
    expect(hasUsableJobDescription("Build embedded systems and test firmware.")).toBe(true);
    expect(hasUsableJobDescription("   ")).toBe(false);
    expect(hasUsableJobDescription("No description available")).toBe(false);
  });

  it("posts the selected job and returns the persisted result", async () => {
    const persisted = { id: "match-1", score: 87, eligibility: "Pass" };
    const fetcher = vi.fn(async () => Response.json({ matchResult: persisted })) as unknown as typeof fetch;

    await expect(requestManualMatch("job-42", fetcher)).resolves.toEqual(persisted);
    expect(fetcher).toHaveBeenCalledWith("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "job-42" }),
    });
  });

  it("turns a model failure into an inline-safe error message", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { error: "The local AI model failed. Try again." },
      { status: 503 },
    )) as unknown as typeof fetch;

    await expect(requestManualMatch("job-42", fetcher)).rejects.toEqual(
      new MatchRequestError("The local AI model failed. Try again."),
    );
  });

  it("normalizes an unreadable failure instead of leaking a runtime exception", async () => {
    const fetcher = vi.fn(async () => new Response("not json", { status: 502 })) as unknown as typeof fetch;

    await expect(requestManualMatch("job-42", fetcher)).rejects.toEqual(
      new MatchRequestError("AI Match failed without returning a readable error."),
    );
  });
});
