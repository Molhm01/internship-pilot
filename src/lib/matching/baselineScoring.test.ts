import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintApprovedFacts } from "./profileFingerprint";
import {
  BASELINE_SCORE_SOURCE,
  calculateBaselineScore,
  fingerprintJobScoringInput,
  type BaselineProfile,
} from "./baselineScoring";

const facts = [
  { id: "education", type: "education", content: "B.S. Electrical Engineering", detail: null },
  { id: "graduation", type: "graduationDate", content: "Expected May 2027", detail: null },
  { id: "python", type: "skill", content: "Python", detail: "Used in approved projects" },
  { id: "fpga", type: "project", content: "FPGA signal processing", detail: "SystemVerilog and Python" },
];

function profile(userId = "user-a", profileFacts = facts): BaselineProfile {
  return { userId, revision: fingerprintApprovedFacts(profileFacts), facts: profileFacts };
}

const job = {
  title: "Electrical Engineering Intern",
  company: "Signal Labs",
  location: "Newark, NJ",
  workplaceType: "Hybrid",
  internshipTerm: "Summer 2027",
  description: "Electrical engineering student. Build FPGA systems using SystemVerilog and Python.",
  disciplineTags: JSON.stringify(["electrical", "fpga"]),
  graduationYears: JSON.stringify([2027, 2028]),
  sponsorship: "Unknown",
  citizenshipOrClearance: false,
  sophomoreEligible: true,
  season: "Summer",
};

describe("deterministic baseline scoring", () => {
  it("produces an immediate integer 0-100 score from approved facts", () => {
    const result = calculateBaselineScore(profile(), job);
    expect(result.scoreSource).toBe(BASELINE_SCORE_SOURCE);
    expect(Number.isInteger(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(JSON.parse(result.explanation)).toMatchObject({ version: "baseline-v1", neutralBase: 50 });
  });

  it("is reproducible and user-specific without inventing missing evidence", () => {
    const first = calculateBaselineScore(profile(), job);
    const second = calculateBaselineScore(profile(), job);
    expect(second).toEqual(first);

    const otherFacts = [{ id: "civil", type: "education", content: "B.S. Civil Engineering", detail: null }];
    const other = calculateBaselineScore(profile("user-b", otherFacts), job);
    expect(other.profileRevision).not.toBe(first.profileRevision);
    expect(other.score).toBeLessThan(first.score);
    expect(JSON.parse(other.explanation).missingEvidence).toContain("graduation-year");
  });

  it("changes the profile revision and baseline immediately when approved facts change", () => {
    const before = calculateBaselineScore(profile(), job);
    const changedFacts = facts.filter((fact) => fact.id !== "fpga");
    const after = calculateBaselineScore(profile("user-a", changedFacts), job);
    expect(after.profileRevision).not.toBe(before.profileRevision);
    expect(after.score).not.toBe(before.score);
    expect(after.score).not.toBeNull();
  });

  it("changes the job fingerprint without producing a null transition when the JD changes", () => {
    const before = calculateBaselineScore(profile(), job);
    const after = calculateBaselineScore(profile(), { ...job, description: `${job.description} Docker required.` });
    expect(after.jobFingerprint).not.toBe(before.jobFingerprint);
    expect(after.jobFingerprint).toBe(fingerprintJobScoringInput({ ...job, description: `${job.description} Docker required.` }));
    expect(Number.isInteger(after.score)).toBe(true);
  });

  it("has no Ollama, model, fetch, or network dependency", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/matching/baselineScoring.ts"), "utf8");
    expect(source).not.toMatch(/ollama|gemini|fetch\(|https?:\/\//i);
  });

  it("meets the bounded local CPU target for a newly discovered job", () => {
    for (let warmup = 0; warmup < 100; warmup += 1) calculateBaselineScore(profile(), job);
    const durations: number[] = [];
    for (let sample = 0; sample < 1_000; sample += 1) {
      const started = performance.now();
      calculateBaselineScore(profile(), job);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor((durations.length - 1) * 0.50)];
    const p95 = durations[Math.floor((durations.length - 1) * 0.95)];
    console.info(`P0_BASELINE_CPU p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms samples=${durations.length}`);
    expect(p95).toBeLessThan(100);
  });
});
