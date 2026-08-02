import { describe, it, expect } from "vitest";
import { ENABLE_LEGACY_APPLICATION_WORKER } from "./legacyWorkerDisabled";

describe("Legacy Application Worker Feature Flag", () => {
  it("should be disabled by default", () => {
    expect(ENABLE_LEGACY_APPLICATION_WORKER).toBe(false);
  });
});