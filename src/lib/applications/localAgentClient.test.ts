import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApplicationSession } from "./localAgentClient";

// Mock the global fetch function
global.fetch = vi.fn();

describe("createApplicationSession (browser client)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should create a session successfully", async () => {
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
      eligibilityScore: 0.65,
      tailoredResumeDocumentId: "resume-123",
    });

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      company: "Test Company",
      jobTitle: "Test Job",
      url: "https://example.com/apply",
      eligibilityScore: 0.65,
      tailoredResumeDocumentId: "resume-123",
      startAutofill: false,
    });
  });

  it("should throw an error when local agent is unavailable", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: "Server Error" }),
    } as unknown as Response);

    await expect(
      createApplicationSession({
        company: "Test Company",
        jobTitle: "Test Job",
        url: "https://example.com/apply",
        tailoredResumeDocumentId: "resume-123",
      })
    ).rejects.toMatchObject({ code: "AGENT_SERVER_UNAVAILABLE" });
  });

  it("should throw an error when authentication fails", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ error: "Authentication failed" }),
    } as unknown as Response);

    await expect(
      createApplicationSession({
        company: "Test Company",
        jobTitle: "Test Job",
        url: "https://example.com/apply",
        tailoredResumeDocumentId: "resume-123",
      })
    ).rejects.toThrow("Authentication failed");
  });

  it("should throw an error for invalid input", async () => {
    await expect(
      createApplicationSession({
        company: "", // Invalid empty company
        jobTitle: "Test Job",
        url: "https://example.com/apply",
        tailoredResumeDocumentId: "resume-123",
      })
    ).rejects.toThrow();
  });

  it("rejects unknown legacy fields intentionally", async () => {
    await expect(
      createApplicationSession({
        company: "Test Company",
        jobTitle: "Test Job",
        url: "https://example.com/apply",
        tailoredResumeDocumentId: "resume-123",
        officialApplyUrl: "https://example.com/apply",
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
