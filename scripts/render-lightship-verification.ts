import "dotenv/config";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import { prisma } from "@/lib/db";
import { buildMasterResumeSource, generateDocumentsForJob } from "@/lib/documents/generate";
import { compileTypst } from "@/lib/documents/typst";
import { extractPdfText } from "@/lib/pdf";
import { getApplicationSettings } from "@/lib/applications/settings";

const JOB_ID = "cmrwsl2xq008dfokuzzs7ykoy";

function absolute(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

async function renderFirstPage(input: string, output: string): Promise<void> {
  const parser = new PDFParse({ data: new Uint8Array(await readFile(input)) });
  try {
    const result = await parser.getScreenshot({ first: 1, desiredWidth: 1530, imageBuffer: true });
    const image = result.pages[0]?.data;
    if (!image) throw new Error(`No page rendered from ${input}.`);
    await writeFile(output, image);
  } finally {
    await parser.destroy();
  }
}

async function main() {
  const outputDir = path.join(process.cwd(), "data", "render-verification");
  await mkdir(outputDir, { recursive: true });
  const [profile, job, settings] = await Promise.all([
    prisma.applicationProfile.findUnique({ where: { id: "default" } }),
    prisma.job.findUnique({ where: { id: JOB_ID } }),
    getApplicationSettings(),
  ]);
  if (!profile || !job) throw new Error("Candidate Profile or Lightship job is missing.");
  if (profile.fullName !== "Molhm Alasri" || profile.email !== "molhmalasri7@gmail.com" || profile.phone !== "(929)-264-3117") {
    throw new Error("Production Candidate Profile does not match the authoritative master resume identity.");
  }

  const untailoredSource = path.join(outputDir, "master-untailored.typ");
  const untailoredPdf = path.join(outputDir, "master-untailored.pdf");
  await writeFile(untailoredSource, buildMasterResumeSource(profile), "utf8");
  const compiled = await compileTypst(untailoredSource, untailoredPdf, process.cwd());
  if (!compiled.ok) throw new Error(`Untailored master compilation failed: ${compiled.stderr}`);

  const generated = await generateDocumentsForJob(JOB_ID, { includeCoverLetter: true });
  if (!generated.coverLetter) throw new Error("Lightship cover letter was not generated.");
  const resumeRecord = await prisma.generatedDocument.findUniqueOrThrow({ where: { id: generated.resume.id } });
  const coverRecord = await prisma.generatedDocument.findUniqueOrThrow({ where: { id: generated.coverLetter.id } });
  const referencePdf = path.join(process.cwd(), "templates", "master_resume_reference.pdf");
  const tailoredPdf = absolute(resumeRecord.storagePath);
  const coverPdf = absolute(coverRecord.storagePath);
  const referencePng = path.join(outputDir, "master-reference.png");
  const untailoredPng = path.join(outputDir, "master-untailored.png");
  const tailoredPng = path.join(outputDir, `lightship-tailored-v${resumeRecord.version}.png`);
  const coverPng = path.join(outputDir, `lightship-cover-letter-v${coverRecord.version}.png`);
  await Promise.all([
    renderFirstPage(referencePdf, referencePng),
    renderFirstPage(untailoredPdf, untailoredPng),
    renderFirstPage(tailoredPdf, tailoredPng),
    renderFirstPage(coverPdf, coverPng),
  ]);

  const [referenceText, untailoredText, tailoredText, coverText] = await Promise.all([
    extractPdfText(new Uint8Array(await readFile(referencePdf))),
    extractPdfText(new Uint8Array(await readFile(untailoredPdf))),
    extractPdfText(new Uint8Array(await readFile(tailoredPdf))),
    extractPdfText(new Uint8Array(await readFile(coverPdf))),
  ]);
  const audit = resumeRecord.tailoringAudit ? JSON.parse(resumeRecord.tailoringAudit) : null;
  const report = {
    candidate: { fullName: profile.fullName, email: profile.email, phone: profile.phone },
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      descriptionCharacters: job.description.length,
      descriptionHash: job.jobDescriptionHash,
      descriptionCapturedAt: job.jobDescriptionCapturedAt,
      responsibilities: JSON.parse(job.jobResponsibilities ?? "[]").length,
      qualifications: JSON.parse(job.jobQualifications ?? "[]").length,
    },
    applicationMode: settings.mode,
    autoSubmitDisabled: true,
    documents: {
      reference: { pdf: referencePdf, png: referencePng, pages: referenceText.pageCount },
      untailored: { pdf: untailoredPdf, png: untailoredPng, pages: untailoredText.pageCount },
      tailored: { id: resumeRecord.id, pdf: tailoredPdf, png: tailoredPng, pages: tailoredText.pageCount, qaStatus: resumeRecord.qaStatus, identityVerified: resumeRecord.identityVerified },
      coverLetter: { id: coverRecord.id, pdf: coverPdf, png: coverPng, pages: coverText.pageCount, qaStatus: coverRecord.qaStatus, identityVerified: coverRecord.identityVerified },
    },
    tailoringAudit: audit,
    forbiddenTermsPresent: /\bJordan Test\b|@example\.com|\bai\b|reliability testing|equipment calibration/i.test(tailoredText.text),
    extractedResumeName: tailoredText.text.split(/\r?\n/).map((line) => line.trim()).find(Boolean),
    coverLetterWords: coverText.text.split(/\s+/).filter(Boolean).length,
  };
  const reportPath = path.join(outputDir, "lightship-verification.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
