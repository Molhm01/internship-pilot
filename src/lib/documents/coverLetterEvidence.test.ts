import { describe, expect, it } from "vitest";
import { buildGroundedCoverLetterParagraphs, DocumentGenerationError } from "./generate";
import type { EvidenceFact } from "./masterResume";

/**
 * Targeted regression coverage for the thin-evidence cover-letter bug found
 * during the local publish-readiness diagnostic: a real generated cover
 * letter came out to ~126 words against the app's own 180-260 word QA gate,
 * with no way to recover on retry. These tests exercise the four evidence
 * tiers called out in that fix — rich, moderate, thin, and insufficient —
 * against the app's real 180-260 word QA range, without a database, Ollama,
 * or Typst compilation (the function under test is pure).
 */

const job = {
  title: "Full Stack Developer Intern",
  company: "Seagate Technology",
  description: "We are looking for an intern comfortable with JavaScript, SQL, Git, and backend development using Node.js.",
};

function fact(id: string, type: string, content: string, detail: string | null = null): EvidenceFact {
  return { id, type, content, detail };
}

function wordCount(paragraphs: string[]): number {
  return paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
}

const richFacts: EvidenceFact[] = [
  fact("edu", "education", "B.S. in Computer Science, State University", "Expected graduation May 2027"),
  fact("py", "skill", "Python", "Used in 3 course projects"),
  fact("js", "skill", "JavaScript", "Built a personal portfolio site"),
  fact("sql", "skill", "SQL", "Used in Database Systems coursework"),
  fact("react", "skill", "React", "Used in course-scheduling web app project"),
  fact("git", "skill", "Git"),
  fact(
    "project",
    "project",
    "Built a course-scheduling web app",
    "React frontend, Node/Express backend, PostgreSQL database, for a class project",
  ),
  fact(
    "exp",
    "experience",
    "IT Help Desk Assistant, University IT Services",
    "Part-time, Sept 2025 - present. Troubleshoot hardware/software issues for students and staff.",
  ),
  fact("course1", "coursework", "Data Structures and Algorithms"),
  fact("course2", "coursework", "Database Systems"),
];

const moderateFacts = richFacts.slice(0, 6);
const thinFacts: EvidenceFact[] = [
  fact("py", "skill", "Python"),
  fact("js", "skill", "JavaScript"),
  fact("sql", "skill", "SQL"),
];
const insufficientFacts: EvidenceFact[] = [fact("git", "skill", "Git")];

describe("buildGroundedCoverLetterParagraphs word-count QA range", () => {
  it("A: a rich evidence profile lands within the 180-260 word QA range", () => {
    const paragraphs = buildGroundedCoverLetterParagraphs(job, richFacts, [], ["JavaScript", "SQL", "Git", "Node.js"]);
    const total = wordCount(paragraphs);
    expect(total).toBeGreaterThanOrEqual(180);
    expect(total).toBeLessThanOrEqual(260);
  });

  it("B: a moderate evidence profile lands within the 180-260 word QA range", () => {
    const paragraphs = buildGroundedCoverLetterParagraphs(job, moderateFacts, [], ["JavaScript", "SQL", "Git"]);
    const total = wordCount(paragraphs);
    expect(total).toBeGreaterThanOrEqual(180);
    expect(total).toBeLessThanOrEqual(260);
  });

  it("C: a thin evidence profile still lands within the 180-260 word QA range (the confirmed bug)", () => {
    const paragraphs = buildGroundedCoverLetterParagraphs(job, thinFacts, [], ["Python", "JavaScript"]);
    const total = wordCount(paragraphs);
    expect(total).toBeGreaterThanOrEqual(180);
    expect(total).toBeLessThanOrEqual(260);
  });

  it("D: insufficient evidence fails explicitly instead of fabricating or padding with filler", () => {
    expect(() => buildGroundedCoverLetterParagraphs(job, insufficientFacts, [], [])).toThrow(DocumentGenerationError);
    expect(() => buildGroundedCoverLetterParagraphs(job, [], [], [])).toThrow(DocumentGenerationError);
  });

  it("stays within the 180-260 range for an unusually large evidence set (upper-bound stress case)", () => {
    const manyFacts: EvidenceFact[] = Array.from({ length: 25 }, (_, i) =>
      fact(
        `extreme-${i}`,
        i % 2 === 0 ? "skill" : "coursework",
        `Extreme Skill ${i}`,
        `A detailed, multi-clause description of extreme skill number ${i}, covering real approved evidence about this competency in some depth.`,
      ),
    );
    const manyKeywords = Array.from({ length: 15 }, (_, i) => `Extreme Requirement ${i}`);
    const paragraphs = buildGroundedCoverLetterParagraphs(job, manyFacts, [], manyKeywords);
    const total = wordCount(paragraphs);
    expect(total).toBeGreaterThanOrEqual(180);
    expect(total).toBeLessThanOrEqual(260);
  });

  it("never states an unsupported qualification as a candidate claim", () => {
    const paragraphs = buildGroundedCoverLetterParagraphs(job, thinFacts, [], ["Python", "JavaScript"]);
    const text = paragraphs.join(" ");
    expect(text).not.toMatch(/\bNode\.js\b/);
    expect(text).not.toMatch(/\bReact\b/);
  });

  it("does not use the forbidden generic phrases the document QA gate rejects", () => {
    const paragraphs = buildGroundedCoverLetterParagraphs(job, richFacts, [], ["JavaScript", "SQL"]);
    const text = paragraphs.join(" ");
    expect(text).not.toMatch(/I am eager to contribute/i);
    expect(text).not.toMatch(/I am particularly drawn to/i);
    expect(text).not.toMatch(/I am passionate about/i);
    expect(text).not.toMatch(/skills align perfectly/i);
  });

  it("is deterministic: identical inputs produce identical output", () => {
    const first = buildGroundedCoverLetterParagraphs(job, richFacts, [], ["JavaScript", "SQL"]);
    const second = buildGroundedCoverLetterParagraphs(job, richFacts, [], ["JavaScript", "SQL"]);
    expect(first).toEqual(second);
  });
});
