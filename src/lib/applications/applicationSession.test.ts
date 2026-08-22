import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApplicationSession } from "./localAgentClient";

// Mock the global fetch function
global.fetch = vi.fn();

// The legacy worker stays off for this suite. Hoisted mocks run before any
// test regardless of where they are written, so it belongs at the top level.
vi.mock("./legacyWorkerDisabled", () => ({
  ENABLE_LEGACY_APPLICATION_WORKER: false,
}));

describe("ApplicationSession Flow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should not call legacy worker when ENABLE_LEGACY_APPLICATION_WORKER=false", async () => {
    const mockResponse = {
      id: "test-session-id",
      officialApplicationUrl: "https://example.com/apply",
      sourceListingUrl: null,
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(mockResponse),
    } as unknown as Response);

    const result = await createApplicationSession({
      company: "Test Company",
      jobTitle: "Test Job",
      url: "https://example.com/apply",
      tailoredResumeDocumentId: "resume-123",
    });

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledTimes(1);
    
    // Verify no legacy worker code was called
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs).toBe("/api/application-sessions");
  });
});
