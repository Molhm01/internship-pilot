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
    resumeFact: { findMany: (...args: unknown[]) => findFacts(...args) },
    resumeBullet: { findMany: (...args: unknown[]) => findBullets(...args) },
    generatedDocument: {
      count: (...args: unknown[]) => countDocuments(...args),
      create: (...args: unknown[]) => createDocument(...args),
    },
  },
}));

// The application profile is assembled from the user-owned models now. The
// projection is mocked rather than the retired singleton table.
vi.mock("@/lib/profile/applicationProfile", () => ({
  applicationProfileForUser: (...args: unknown[]) => findProfile(...args),
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
  { id: "sensor", type: "project", content: "Air Quality Monitor", detail: "Sampled and filtered MQ-135 sensor data.", status: "approved" },
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
    const result = await generateDocumentsForJob(job.id, "test-user", { includeCoverLetter: true });

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
    await generateDocumentsForJob(job.id, "test-user", { includeCoverLetter: true });
    await generateDocumentsForJob(job.id, "test-user", { includeCoverLetter: true });

    expect(persisted.map((record) => `${String(record.type)}:${String(record.version)}`)).toEqual([
      "resume:1",
      "coverLetter:1",
      "resume:2",
      "coverLetter:2",
    ]);
    expect(persisted).toHaveLength(4);
  });

  it("corrects unsupported master-skill wording and persists the corrected documents as V2", async () => {
    const existingResume = { id: "resume-v1", type: "resume", version: 1, qaStatus: "pass", storagePath: "resume-v1.pdf" };
    const existingCover = { id: "cover-v1", type: "coverLetter", version: 1, qaStatus: "pass", storagePath: "cover-v1.pdf" };
    persisted.push(existingResume, existingCover);
    findJob.mockResolvedValue({
      ...job,
      description: `${job.description} The role requests real-time data acquisition and reliability testing.`,
      matchResults: [{
        ...job.matchResults[0],
        skillsNeverAdd: JSON.stringify([
          { skill: "real-time data acquisition" },
          { skill: "reliability testing" },
        ]),
      }],
    });

    const result = await generateDocumentsForJob(job.id, "test-user", { includeCoverLetter: true });

    expect(result.resume).toMatchObject({ id: "resume-v2", version: 2, qaStatus: "pass" });
    expect(result.coverLetter).toMatchObject({ id: "coverLetter-v2", version: 2, qaStatus: "pass" });
    expect(persisted[0]).toEqual(existingResume);
    expect(persisted[1]).toEqual(existingCover);
    expect(persisted).toHaveLength(4);
    const generatedSources = writeFile.mock.calls.map((call) => String(call[1])).join("\n");
    expect(generatedSources).not.toMatch(/real-time data acquisition/i);
    expect(generatedSources).not.toMatch(/reliability testing/i);
    expect(generatedSources).toContain("sensor data sampling");
    expect(generatedSources).toContain("system stability testing");
    expect(compileTypst).toHaveBeenCalledTimes(2);
    expect(evaluateStrictDocumentQa).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(persisted[2].tailoringAudit))).toMatchObject({
      unsupportedWordingRemoved: [
        expect.objectContaining({ phrase: "real-time data acquisition", sourceSection: "Skills: Embedded Systems" }),
        expect.objectContaining({ phrase: "reliability testing", sourceSection: "Skills: Additional" }),
      ],
    });
  });

  it("reports the resume persistence stage without altering an existing V1", async () => {
    persisted.push({ id: "resume-v1", type: "resume", version: 1, qaStatus: "pass" });
    createDocument.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(generateDocumentsForJob(job.id, "test-user", { includeCoverLetter: true })).rejects.toMatchObject({
      message: "Resume persistence failed. Existing document versions were kept.",
      stage: "resume_persistence",
    });
    expect(persisted).toEqual([{ id: "resume-v1", type: "resume", version: 1, qaStatus: "pass" }]);
  });

  it("blocks an irremovable fabricated credential before files or records are created", async () => {
    findJob.mockResolvedValue({
      ...job,
      matchResults: [{
        ...job.matchResults[0],
        skillsNeverAdd: JSON.stringify([{ skill: "Dean's List" }]),
      }],
    });

    await expect(generateDocumentsForJob(job.id, "test-user", { includeCoverLetter: true })).rejects.toMatchObject({
      stage: "validation",
      unsupportedClaims: [expect.objectContaining({
        phrase: "Dean's List",
        sourceSection: "Education 2 degree",
      })],
    });
    expect(writeFile).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
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

    await generateDocumentsForJob(job.id, "test-user", { includeCoverLetter: false });

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

    await expect(generateDocumentsForJob(job.id, "test-user")).rejects.toEqual(
      new DocumentGenerationError("A usable job description is required before tailored documents can be generated."),
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("archives a QA-failed version and returns a safe failure instead of generating a cover letter", async () => {
    persisted.push({ id: "resume-v1", type: "resume", version: 1, qaStatus: "pass" });
    evaluateStrictDocumentQa.mockReturnValueOnce({ status: "fail", issues: ["Unsupported claim detected."] });

    await expect(generateDocumentsForJob(job.id, "test-user")).rejects.toThrow("Resume generation failed QA");
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ id: "resume-v1", version: 1, qaStatus: "pass" });
    expect(persisted[1]).toMatchObject({ type: "resume", version: 2, qaStatus: "fail" });
    expect(persisted.some((record) => record.type === "coverLetter")).toBe(false);
  });

  it("falls back to the untailored master when tailoring will not fit on one page", async () => {
    // The master résumé fills its page with almost no slack, so a longer verb
    // or an added keyword can push the tailored version onto a second page.
    // The applicant should still get a résumé — their own, approved, one page —
    // rather than nothing at all.
    // A posting the tailoring path actually substitutes a bullet for — the
    // "problem solving" competency, evidenced by the PC-repair fact. With no
    // substitutions there is nothing to fall back from, and recompiling the
    // same content would produce the same overflowing page.
    findJob.mockResolvedValue({
      ...job,
      description: `${job.description} You will troubleshoot and diagnose hardware issues on the bench.`,
    });
    findFacts.mockResolvedValue([
      ...facts,
      { id: "repairs", type: "experience", content: "PC Builder and Repair Technician", detail: "Completed 100+ hardware repairs; diagnosed desktop and laptop issues and replaced RAM, SSDs and GPUs.", status: "approved" },
    ]);
    evaluateResumeFormatPreservation
      .mockResolvedValueOnce({ status: "fail", issues: ["Master format requires one page; found 2."], generated: {}, reference: {} })
      .mockResolvedValue({ status: "pass", issues: [], generated: {}, reference: {} });

    // Résumé only: the cover letter is a separate document with its own QA,
    // and it is not what this is about.
    const result = await generateDocumentsForJob(job.id, "test-user", { includeCoverLetter: false });

    expect(result.resume.qaStatus).toBe("pass");
    expect(compileTypst).toHaveBeenCalledTimes(2); // the tailored attempt, then the master fallback
    const resume = persisted.find((record) => record.type === "resume");
    expect(resume).toMatchObject({ tailoringStatus: "MASTER_RESUME_FALLBACK" });
  });

  it("does not fall back when the résumé says the wrong things", async () => {
    // A content or identity failure is not a formatting problem, and
    // recompiling the same facts would not fix it.
    evaluateStrictDocumentQa.mockReturnValueOnce({ status: "fail", issues: ["Unsupported claim detected."] });
    evaluateResumeFormatPreservation
      .mockResolvedValueOnce({ status: "fail", issues: ["Master format requires one page; found 2."], generated: {}, reference: {} })
      .mockResolvedValue({ status: "pass", issues: [], generated: {}, reference: {} });

    await expect(generateDocumentsForJob(job.id, "test-user")).rejects.toThrow("Resume generation failed QA");
    expect(compileTypst).toHaveBeenCalledTimes(1);
  });
});
