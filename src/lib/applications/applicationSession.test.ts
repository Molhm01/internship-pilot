import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApplicationSession } from "./localAgentClient";
import { ENABLE_LEGACY_APPLICATION_WORKER } from "./legacyWorkerDisabled";

// Mock the global fetch function
global.fetch = vi.fn();

describe("ApplicationSession Flow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Ensure legacy is disabled
    vi.mock("./legacyWorkerDisabled", () => ({
      ENABLE_LEGACY_APPLICATION_WORKER: false
    }));
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
    } as any);

    const result = await createApplicationSession({
      company: "Test Company",
      jobTitle: "Test Job",
      url: "https://example.com/apply",
      tailoredResumeDocumentId: "resume-123",
    });

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledTimes(1);
    
    // Verify no legacy worker code was called
    const callArgs = (fetch as any).mock.calls[0][0];
    expect(callArgs).toBe("/api/application-sessions");
  });
});
