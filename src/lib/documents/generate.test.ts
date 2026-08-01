import { beforeEach, describe, expect, it, vi } from "vitest";

const findJob = vi.fn();
const findProfile = vi.fn();
const findFacts = vi.fn();
const findBullets = vi.fn();
const countDocuments = vi.fn();
const createDocument = vi.fn();
const mkdir = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const compileTypst = vi.fn();
const extractPdfText = vi.fn();
const evaluateStrictDocumentQa = vi.fn();
const evaluatePdfLayoutQa = vi.fn();
const evaluateResumeFormatPreservation = vi.fn();
const validateDocumentIdentity = vi.fn();
const selectContentForJob = vi.fn();
const logAudit = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: { findUnique: (...args: unknown[]) => findJob(...args) },
    applicationProfile: { findUnique: (...args: unknown[]) => findProfile(...args) },
    resumeFact: { findMany: (...args: unknown[]) => findFacts(...args) },
    resumeBullet: { findMany: (...args: unknown[]) => findBullets(...args) },
    generatedDocument: {
      count: (...args: unknown[]) => countDocuments(...args),
      create: (...args: unknown[]) => createDocument(...args),
    },
  },
}));

vi.mock("node:fs/promises", () => ({
  mkdir: (...args: unknown[]) => mkdir(...args),
  readFile: (...args: unknown[]) => readFile(...args),
  writeFile: (...args: unknown[]) => writeFile(...args),
}));

vi.mock("@/lib/documents/typst", async (importOriginal) => {
  const original = await importOriginal<typeof import("./typst")>();
  return { ...original, compileTypst: (...args: unknown[]) => compileTypst(...args) };
});
vi.mock("@/lib/pdf", () => ({ extractPdfText: (...args: unknown[]) => extractPdfText(...args) }));
vi.mock("@/lib/documents/qa", () => ({ evaluateStrictDocumentQa: (...args: unknown[]) => evaluateStrictDocumentQa(...args) }));
vi.mock("@/lib/documents/layoutQa", () => ({
  evaluatePdfLayoutQa: (...args: unknown[]) => evaluatePdfLayoutQa(...args),
  evaluateResumeFormatPreservation: (...args: unknown[]) => evaluateResumeFormatPreservation(...args),
}));
vi.mock("@/lib/documents/identityGuard", () => ({ validateDocumentIdentity: (...args: unknown[]) => validateDocumentIdentity(...args) }));
vi.mock("@/lib/documents/select", () => ({ selectContentForJob: (...args: unknown[]) => selectContentForJob(...args) }));
vi.mock("@/lib/applications/audit", () => ({ logAudit: (...args: unknown[]) => logAudit(...args) }));

import { DocumentGenerationError, generateDocumentsForJob } from "./generate";

const job = {
  id: "job-1",
  title: "Python Signal Processing Intern",
  company: "Signal Labs",
  description: "Build and test signal-processing software with Python, document verification results, and collaborate with electrical engineers on reliable receiver systems throughout the product lifecycle.",
  jobResponsibilities: null,
  jobQualifications: null,
  matchResults: [{
    id: "match-1",
    score: 84,
    eligibility: "Pass",
    skillsSupported: JSON.stringify([{ skill: "Python" }]),
    skillsNeedConfirmation: JSON.stringify([{ skill: "Git" }]),
    skillsToLearn: JSON.stringify([{ skill: "Docker" }]),
    skillsNeverAdd: JSON.stringify([{ skill: "Rust" }]),
  }],
};

const profile = {
  fullName: "Alex Candidate",
  email: "alex@candidate.dev",
  phone: "973-555-0142",
  linkedin: "linkedin.com/in/alex-candidate",
  workAuthorization: null,
  addressCity: "Newark",
  addressState: "NJ",
};

const facts = [
  { id: "education", type: "education", content: "New Jersey Institute of Technology, B.S. Electrical Engineering (Transferred)", detail: null, status: "approved" },
  { id: "graduation", type: "graduationDate", content: "Expected May 2029", detail: null, status: "approved" },
  { id: "course", type: "coursework", content: "Digital Design", detail: null, status: "approved" },
  { id: "python", type: "skill", content: "Python", detail: null, status: "approved" },
  { id: "project", type: "project", content: "Software-Defined Radio ADS-B Receiver Python, RTL-SDR", detail: "Captured raw IQ at 1090 MHz. Validated frames with CRC-24 error detection. Parsed ICAO addresses.", status: "approved" },
  { id: "experience", type: "experience", content: "PC Builder and Repair Technician, Freelance", detail: "Built 30+ custom PCs. Diagnosed desktop and laptop issues. Tested each system for stability.", status: "approved" },
  { id: "activity", type: "activity", content: "IEEE - Member", detail: null, status: "approved" },
  { id: "unsafe", type: "skill", content: "Docker", detail: "Unconfirmed", status: "approved" },
];

describe("generateDocumentsForJob", () => {
  const persisted: Array<Record<string, unknown>> = [];
  let extractionNumber = 0;

  beforeEach(() => {
    vi.resetAllMocks();
    persisted.length = 0;
    extractionNumber = 0;
    findJob.mockResolvedValue(job);
    findProfile.mockResolvedValue(profile);
    findFacts.mockResolvedValue(facts);
    findBullets.mockResolvedValue([{ id: "bullet-project", category: "project", text: "Captured raw IQ", factIds: JSON.stringify(["project"]), createdAt: new Date() }]);
    selectContentForJob.mockResolvedValue({ experienceBulletIds: [], projectBulletIds: ["bullet-project"], activityBulletIds: [], coverLetterParagraphs: [] });
    countDocuments.mockImplementation(({ where }: { where: { type: string } }) => persisted.filter((item) => item.type === where.type).length);
    createDocument.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const record = { id: `${String(data.type)}-v${String(data.version)}`, createdAt: new Date(), ...data };
      persisted.push(record);
      return Promise.resolve(record);
    });
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
    readFile.mockResolvedValue(Buffer.from("%PDF"));
    compileTypst.mockResolvedValue({ ok: true, stderr: "" });
    extractPdfText.mockImplementation(() => {
      extractionNumber += 1;
      return Promise.resolve({
        text: extractionNumber % 2 === 0
          ? `Alex Candidate alex@candidate.dev 973-555-0142 Dear Signal Labs Hiring Team, Python Signal Processing Intern Sincerely,`
          : "Alex Candidate alex@candidate.dev 973-555-0142 EDUCATION EXPERIENCE PROJECTS SKILLS ACTIVITIES & LEADERSHIP",
        pageCount: 1,
      });
    });
    evaluateStrictDocumentQa.mockReturnValue({ status: "pass", issues: [] });
    evaluatePdfLayoutQa.mockResolvedValue({ pageCount: 1, issues: [], metrics: {} });
    evaluateResumeFormatPreservation.mockResolvedValue({ status: "pass", issues: [], generated: {}, reference: {} });
    validateDocumentIdentity.mockReturnValue([]);
    logAudit.mockResolvedValue(undefined);
  });

  it("creates and persists a QA-approved resume and cover-letter PDF", async () => {
    const result = await generateDocumentsForJob(job.id, { includeCoverLetter: true });

    expect(result.resume).toMatchObject({ type: "resume", version: 1, qaStatus: "pass" });
    expect(result.coverLetter).toMatchObject({ type: "coverLetter", version: 1, qaStatus: "pass" });
    expect(compileTypst).toHaveBeenCalledTimes(2);
    expect(compileTypst.mock.calls.map((call) => String(call[1]))).toEqual(expect.arrayContaining([
      expect.stringMatching(/resume-v1\.pdf$/),
      expect.stringMatching(/cover-letter-v1\.pdf$/),
    ]));
    expect(persisted).toHaveLength(2);
    expect(persisted.every((record) => record.qaStatus === "pass" && record.identityVerified === true)).toBe(true);
    const sources = writeFile.mock.calls.map((call) => String(call[1])).join("\n");
    expect(sources).toContain("Captured raw IQ at 1090 MHz");
    expect(sources).toContain("Built 30+ custom PCs");
    expect(sources).not.toContain("Docker");
    expect(sources).not.toContain("Rust");
    expect(sources).toContain("NYC Metro Area");
    expect(sources).toContain("Stevens Institute of Technology");
    expect(evaluateResumeFormatPreservation).toHaveBeenCalledOnce();
  });

  it("appends V2 without overwriting the V1 records", async () => {
    await generateDocumentsForJob(job.id, { includeCoverLetter: true });
    await generateDocumentsForJob(job.id, { includeCoverLetter: true });

    expect(persisted.map((record) => `${String(record.type)}:${String(record.version)}`)).toEqual([
      "resume:1",
      "coverLetter:1",
      "resume:2",
      "coverLetter:2",
    ]);
    expect(persisted).toHaveLength(4);
  });

  it("reclassifies grounded transferable competencies without admitting unsupported tools", async () => {
    findJob.mockResolvedValue({
      ...job,
      title: "Civil Engineering Intern",
      description: "Use strong analytical skills and problem-solving skills and work collaboratively with the project team. AutoCAD is required for design documentation and technical project delivery.",
      matchResults: [{
        ...job.matchResults[0],
        skillsSupported: "[]",
        skillsNeedConfirmation: JSON.stringify([{ skill: "ability to work collaboratively" }]),
        skillsToLearn: JSON.stringify([{ skill: "problem-solving skills" }]),
        skillsNeverAdd: JSON.stringify([{ skill: "strong analytical skills" }, { skill: "AutoCAD" }]),
      }],
    });

    await generateDocumentsForJob(job.id, { includeCoverLetter: false });

    const source = writeFile.mock.calls.map((call) => String(call[1])).join("\n");
    expect(source).toContain("Analyzed raw IQ data at 1090 MHz");
    expect(source).toContain("Diagnosed and resolved desktop and laptop hardware failures");
    expect(source).toContain("Coordinated peak-hour task assignments with coworkers");
    expect(source).not.toContain("AutoCAD");
    const record = persisted[0];
    expect(JSON.parse(String(record.keywordClassification))).toMatchObject({
      supported: expect.arrayContaining(["Analyzed", "resolved", "Coordinated"]),
      unsupported: ["AutoCAD"],
    });
    expect(JSON.parse(String(record.tailoringAudit))).toMatchObject({
      status: "TAILORED_WITH_SUPPORTED_CHANGES",
      formattingPreservation: { status: "pass" },
      unsupportedRequirementsNotAdded: ["AutoCAD"],
    });
  });

  it("rejects a missing job description before creating files or records", async () => {
    findJob.mockResolvedValue({ ...job, description: "" });

    await expect(generateDocumentsForJob(job.id)).rejects.toEqual(
      new DocumentGenerationError("A usable job description is required before tailored documents can be generated."),
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("archives a QA-failed version and returns a safe failure instead of generating a cover letter", async () => {
    persisted.push({ id: "resume-v1", type: "resume", version: 1, qaStatus: "pass" });
    evaluateStrictDocumentQa.mockReturnValueOnce({ status: "fail", issues: ["Unsupported claim detected."] });

    await expect(generateDocumentsForJob(job.id)).rejects.toThrow("Resume generation failed QA");
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ id: "resume-v1", version: 1, qaStatus: "pass" });
    expect(persisted[1]).toMatchObject({ type: "resume", version: 2, qaStatus: "fail" });
    expect(persisted.some((record) => record.type === "coverLetter")).toBe(false);
  });
});
