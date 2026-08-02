import { describe, expect, it } from "vitest";
import { normalizeMatchDescription, selectRelevantApprovedFacts } from "./input";

const facts = [
  { id: "education", type: "education", content: "Computer Engineering student", detail: null },
  { id: "python", type: "skill", content: "Python", detail: "Receiver automation" },
  { id: "autocad", type: "skill", content: "AutoCAD", detail: null },
  { id: "repair", type: "experience", content: "Diagnosed and repaired hardware", detail: null },
];

describe("AI Match input reduction", () => {
  it("retains grounding context and only job-relevant standalone skills", () => {
    const selected = selectRelevantApprovedFacts(
      facts,
      "Use Python to diagnose embedded hardware and analyze test results.",
    );
    expect(selected.map((fact) => fact.id)).toEqual(["education", "python", "repair"]);
    expect(selected.map((fact) => fact.id)).not.toContain("autocad");
  });

  it("normalizes and safely truncates excessive descriptions", () => {
    const normalized = normalizeMatchDescription(`  Build   systems.\r\n\r\n${"Test devices. ".repeat(200)}`, 220);
    expect(normalized.length).toBeLessThanOrEqual(245);
    expect(normalized).toContain("Build systems.");
    expect(normalized).toContain("[Description truncated]");
  });
});
