import { describe, expect, it } from "vitest";

import {
  heartbeatIsHealthy,
  pauseIsActive,
  type SchedulerHeartbeat,
  type SchedulerPauseMetadata,
} from "@/lib/sync/schedulerState";

const NOW = new Date("2026-08-24T04:00:00.000Z");

function pause(expiresAt: string | null): SchedulerPauseMetadata {
  return {
    paused: true,
    source: "test-scheduler",
    reason: "bounded_test",
    changedAt: "2026-08-24T03:58:00.000Z",
    expiresAt,
  };
}

function heartbeat(lastSeenAt: string): SchedulerHeartbeat {
  return {
    startedAt: "2026-08-24T03:00:00.000Z",
    lastSeenAt,
    pid: 1234,
    runtime: "local",
  };
}

describe("scheduler operational state", () => {
  it("does not let an expired temporary test pause remain active", () => {
    expect(pauseIsActive("true", pause("2026-08-24T03:59:59.000Z"), NOW)).toBe(false);
  });

  it("retains an intentional manual pause without an expiry", () => {
    expect(pauseIsActive("true", pause(null), NOW)).toBe(true);
  });

  it("reports a live worker heartbeat and rejects a stale one", () => {
    expect(heartbeatIsHealthy(heartbeat("2026-08-24T03:59:30.000Z"), NOW)).toBe(true);
    expect(heartbeatIsHealthy(heartbeat("2026-08-24T03:58:00.000Z"), NOW)).toBe(false);
  });
});
