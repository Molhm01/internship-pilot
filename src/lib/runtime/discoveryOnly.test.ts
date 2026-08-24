import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("discovery-only local operations", () => {
  it("does not select Ollama or start the application worker", () => {
    const entry = source("scripts/local-entry.ts");
    const supervisor = source("scripts/local.ts");
    expect(entry).toContain('if (!args.includes("--discovery-only")) configureOllamaModel()');
    expect(supervisor).toContain('process.env.DATABASE_POOL_MAX = "3"');
    expect(supervisor).toContain('process.env.SCHEDULER_SCORING_ENABLED = "false"');
    expect(supervisor).toContain('Application/browser worker disabled (--discovery-only).');
  });

  it("passes the scoring-off contract into the persistent scheduler", () => {
    const worker = source("scripts/scheduler-worker.ts");
    const scheduler = source("src/lib/sync/scheduler.ts");
    expect(worker).toContain('process.env.SCHEDULER_SCORING_ENABLED !== "false"');
    expect(worker).toContain("startScheduler({ scoringEnabled })");
    expect(scheduler).toContain("if (scoringEnabled) {");
    expect(scheduler).toContain("if (scoringEnabled) setInterval(runScoringMaintenance");
    expect(scheduler).toContain("setInterval(runQualityHydration");
    expect(scheduler).toContain("await runQualityHydration()");
  });
});
