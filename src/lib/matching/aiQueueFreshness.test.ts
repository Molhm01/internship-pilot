import { describe, expect, it } from "vitest";
import { aiQueueFreshnessBucket, compareAiQueueFreshness } from "./initialAiMatchQueue";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

describe("AI refinement fresh-first priority", () => {
  it("orders <24h ahead of <72h, <=7d, 8-14d, older, and unknown", () => {
    expect(aiQueueFreshnessBucket(ago(1), NOW)).toBe(0);
    expect(aiQueueFreshnessBucket(ago(30), NOW)).toBe(1);
    expect(aiQueueFreshnessBucket(ago(96), NOW)).toBe(2);
    expect(aiQueueFreshnessBucket(ago(10 * 24), NOW)).toBe(3);
    expect(aiQueueFreshnessBucket(ago(20 * 24), NOW)).toBe(4);
    expect(aiQueueFreshnessBucket(null, NOW)).toBe(5);
  });

  it("never lets historical backlog outrank a job posted minutes ago", () => {
    const rows = [
      ...Array.from({ length: 900 }, (_, index) => ({ id: `old-${index}`, sourcePostedAt: ago(21 * 24) })),
      { id: "fresh", sourcePostedAt: ago(1 / 3) },
      { id: "unknown", sourcePostedAt: null },
    ].sort((a, b) => compareAiQueueFreshness(a, b, NOW));
    expect(rows[0].id).toBe("fresh");
    expect(rows.at(-1)?.id).toBe("unknown");
  });
});
