import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvedFactsExcludingUnsupportedClaims,
  buildGroundedCoverLetterParagraphs,
  findUnsupportedClaims,
} from "./generate";
import { groundedMasterContent, tailoredMasterContent, type EvidenceFact } from "./masterResume";

const facts: EvidenceFact[] = [
  {
    id: "education",
    type: "education",
    content: "New Jersey Institute of Technology, B.S. Electrical Engineering (Transferred)",
    detail: null,
  },
  { id: "graduation", type: "graduationDate", content: "Expected May 2029", detail: null },
  { id: "course", type: "coursework", content: "Digital Design", detail: null },
  { id: "python", type: "skill", content: "Python", detail: null },
  {
    id: "project",
    type: "project",
    content: "Software-Defined Radio ADS-B Receiver Python, RTL-SDR",
    detail: "Captured raw IQ at 1090 MHz. Validated frames with CRC-24 error detection. Parsed ICAO addresses.",
  },
  {
    id: "experience",
    type: "experience",
    content: "PC Builder and Repair Technician, Freelance",
    detail: "Built 30+ custom PCs. Diagnosed desktop and laptop issues. Tested each system for stability.",
  },
  { id: "activity", type: "activity", content: "IEEE - Member", detail: null },
];

describe("grounded tailored documents", () => {
  it("preserves the complete approved master résumé structure", () => {
    const content = groundedMasterContent(facts);
    expect(content.education.map((item) => item.school)).toEqual([
      "New Jersey Institute of Technology",
      "Stevens Institute of Technology",
    ]);
    expect(content.projects[0].bullets[0]).toContain("Captured raw IQ at 1090 MHz (2 MSPS)");
    expect(content.skills.flatMap((group) => group.items)).toContain("Python");
    expect(JSON.stringify(content)).toContain("100+ hardware repairs");
    expect(content.education[0].location).toBe("Newark, NJ");
  });

  it("uses the current job description to tailor ordering and records unsupported gaps", () => {
    const result = tailoredMasterContent(
      {
        title: "Python Signal Processing Intern",
        description: "Use Python and signal processing. Docker is required.",
      },
      facts,
      75,
      { selectedFactIds: ["project"], unsupportedQualifications: ["Docker"] },
    );
    expect(result.audit.status).toBe("TAILORED_WITH_SUPPORTED_CHANGES");
    expect(result.audit.supportedKeywords.map((item) => item.keyword)).toContain("Python");
    expect(result.audit.unsupportedRequirementsNotAdded).toEqual(["Docker"]);
    expect(result.content.projects[0].title).toContain("Software-Defined Radio");
  });

  it("builds cover-letter evidence only from approved facts", () => {
    const paragraphs = buildGroundedCoverLetterParagraphs(
      {
        title: "Python Signal Processing Intern",
        company: "Acme",
        description: "Use Python for signal processing.",
      },
      facts,
      ["project"],
    );
    const text = paragraphs.join(" ");
    expect(text).toContain("Python Signal Processing Intern");
    expect(text).toContain("Captured raw IQ at 1090 MHz");
    expect(text).not.toContain("Docker");
    expect(text).not.toContain("ten years");
  });

  it("excludes AI Match Never-claim and unconfirmed items from document facts", () => {
    const conflictingFacts: EvidenceFact[] = [
      ...facts,
      { id: "docker", type: "skill", content: "Docker", detail: "Needs confirmation" },
    ];
    const safeFacts = approvedFactsExcludingUnsupportedClaims(conflictingFacts, ["Docker"]);
    const paragraphs = buildGroundedCoverLetterParagraphs(
      {
        title: "Python Signal Processing Intern",
        company: "Acme",
        description: "Use Python and Docker for signal processing.",
      },
      safeFacts,
      ["project"],
    );

    expect(safeFacts.map((fact) => fact.id)).not.toContain("docker");
    expect(findUnsupportedClaims(paragraphs.join(" "), ["Docker"])).toEqual([]);
  });

  it("keeps the job page connected to canonical records, QA, history, audit, PDFs, and inline errors", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/app/jobs/[id]/page.tsx"),
      "utf8",
    );
    expect(source).toContain("fetchJobDocuments(id)");
    expect(source).toContain("generateTailoredDocuments(id)");
    expect(source).toContain("fetchDocumentPdf(document.id)");
    expect(source).toContain("Generate tailored documents");
    expect(source).toContain("Regenerate documents");
    expect(source).toContain("Open PDF");
    expect(source).toContain("Previous versions");
    expect(source).toContain("Tailoring Audit");
    expect(source).toContain("Formatting preservation:");
    expect(source).toContain("Keywords intentionally excluded:");
    expect(source).toContain("Generated {new Date(document.createdAt).toLocaleString()}");
    expect(source).toContain("QA ${document.qaStatus}");
    expect(source).toContain("setDocError(error instanceof Error");
  });
});
