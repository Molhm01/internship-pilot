import { describe, expect, it } from "vitest";
import {
  isSupportedTransferableRequirement,
  recognizeSupportedTransferableCompetencies,
  tailoredMasterContent,
  type EvidenceFact,
} from "./masterResume";

const evidenceFacts: EvidenceFact[] = [
  {
    id: "adsb",
    type: "project",
    content: "Software-Defined Radio ADS-B Receiver",
    detail: "Analyzed raw IQ data at 1090 MHz, implemented preamble correlation, and implemented pulse-position demodulation.",
  },
  {
    id: "repair",
    type: "experience",
    content: "PC Builder and Repair Technician",
    detail: "Completed 100+ hardware repairs, diagnosed desktop and laptop issues, and replaced failed RAM, SSDs, GPUs, and cooling components.",
  },
  {
    id: "shift-lead",
    type: "experience",
    content: "Sales Associate / Shift Lead",
    detail: "Coordinated peak-hour task assignments and worked in customer-facing daily store operations.",
  },
];

const civilJob = {
  title: "Civil Engineering Intern",
  description: "Use strong analytical skills and problem-solving skills while demonstrating the ability to work collaboratively with a multidisciplinary team. AutoCAD and Civil 3D experience are preferred.",
};

describe("evidence-backed résumé tailoring", () => {
  it("recognizes analytical ability from technical-analysis evidence", () => {
    const competencies = recognizeSupportedTransferableCompetencies(civilJob.description, evidenceFacts);
    const analytical = competencies.find((item) => item.competency === "analytical ability");

    expect(analytical?.evidence.map((item) => item.factId)).toContain("adsb");
    expect(analytical?.tailoredBullet).toContain("Analyzed raw IQ data at 1090 MHz");
  });

  it("recognizes problem solving from repair and diagnostic evidence", () => {
    const competencies = recognizeSupportedTransferableCompetencies(civilJob.description, evidenceFacts);
    const problemSolving = competencies.find((item) => item.competency === "problem solving");

    expect(problemSolving?.evidence.map((item) => item.factId)).toContain("repair");
    expect(problemSolving?.tailoredBullet).toContain("Diagnosed and resolved");
  });

  it("recognizes collaboration from shift-lead task coordination", () => {
    const competencies = recognizeSupportedTransferableCompetencies(civilJob.description, evidenceFacts);
    const collaboration = competencies.find((item) => item.competency === "collaboration");

    expect(collaboration?.evidence.map((item) => item.factId)).toContain("shift-lead");
    expect(collaboration?.tailoredBullet).toContain("Coordinated peak-hour task assignments with coworkers");
  });

  it("does not reclassify unsupported factual tools as transferable competencies", () => {
    expect(isSupportedTransferableRequirement("strong analytical skills")).toBe(true);
    expect(isSupportedTransferableRequirement("problem-solving skills")).toBe(true);
    expect(isSupportedTransferableRequirement("ability to work collaboratively")).toBe(true);
    expect(isSupportedTransferableRequirement("AutoCAD")).toBe(false);
    expect(isSupportedTransferableRequirement("Civil 3D")).toBe(false);
  });

  it("rewrites supported bullets, excludes unsupported tools, and improves the audit score", () => {
    const result = tailoredMasterContent(civilJob, evidenceFacts, 92, {
      supportedRequirements: [
        "strong analytical skills",
        "problem-solving skills",
        "ability to work collaboratively",
      ],
      unsupportedQualifications: ["AutoCAD", "Civil 3D"],
    });

    expect(result.audit.status).toBe("TAILORED_WITH_SUPPORTED_CHANGES");
    expect(result.audit.tailoredAtsMatchScore).toBeGreaterThan(92);
    expect(result.audit.unsupportedRequirementsNotAdded).toEqual(["AutoCAD", "Civil 3D"]);
    expect(result.audit.keywordsAdded).toEqual(expect.arrayContaining(["Analyzed", "resolved", "Coordinated"]));
    expect(result.audit.bulletsChanged).toEqual(expect.arrayContaining([
      expect.objectContaining({
        original: "Diagnosed desktop and laptop issues; replaced RAM, SSDs, GPUs, and cooling components.",
        tailored: "Diagnosed and resolved desktop and laptop hardware failures by testing and replacing RAM, SSDs, GPUs, and cooling components.",
        jobRequirementAddressed: "problem-solving skills",
      }),
      expect.objectContaining({
        original: "Reorganized peak-hour task assignments to improve workflow and reduce customer wait times.",
        tailored: "Coordinated peak-hour task assignments with coworkers to improve workflow and reduce customer wait times.",
        jobRequirementAddressed: "ability to work collaboratively",
      }),
      expect.objectContaining({
        original: "Captured raw IQ at 1090 MHz (2 MSPS) and implemented preamble correlation and pulse-position demodulation to recover 112-bit Mode S extended squitter frames.",
        tailored: "Analyzed raw IQ data at 1090 MHz and implemented preamble correlation and pulse-position demodulation to recover 112-bit Mode S frames.",
        jobRequirementAddressed: "strong analytical skills",
      }),
    ]));
    expect(JSON.stringify(result.content)).not.toContain("AutoCAD");
    expect(JSON.stringify(result.content)).not.toContain("Civil 3D");
  });

  it("cannot label a zero-change résumé as successfully tailored", () => {
    const result = tailoredMasterContent(
      {
        title: "Civil Engineering Intern",
        description: "AutoCAD, Civil 3D, HEC-RAS, and a Civil Engineering degree are required.",
      },
      evidenceFacts,
      92,
      { unsupportedQualifications: ["AutoCAD", "Civil 3D", "HEC-RAS", "Civil Engineering degree"] },
    );

    expect(result.audit.bulletsChanged).toHaveLength(0);
    expect(result.audit.bulletsReordered).toHaveLength(0);
    expect(result.audit.status).toBe("NO_SUPPORTED_TAILORING_CHANGES");
    expect(result.audit.tailoredAtsMatchScore).toBe(92);
    expect(result.audit.scoreMethod).toContain("intentionally left unchanged");
  });
});
