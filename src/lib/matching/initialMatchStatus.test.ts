import { describe, expect, it } from "vitest";
import { initialMatchUiStatus } from "./initialMatchStatus";

describe("initial AI Match job-list status", () => {
  it("maps durable queue states without polling", () => {
    expect(initialMatchUiStatus("DESCRIPTION_PENDING", false)).toBe("Preparing job details");
    expect(initialMatchUiStatus("QUEUED", false)).toBe("Scoring");
    expect(initialMatchUiStatus("SCORING", false)).toBe("Scoring");
    expect(initialMatchUiStatus("RETRYABLE_FAILED", false)).toBe("Scoring delayed");
    expect(initialMatchUiStatus("FAILED", false)).toBe("Not scored");
    expect(initialMatchUiStatus("NOT_SCORED", false)).toBe("Not scored");
    expect(initialMatchUiStatus("SCORED", true)).toBeNull();
  });
});
