import "dotenv/config";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildMasterResumeSource } from "@/lib/documents/generate";
import { tailoredMasterContent } from "@/lib/documents/masterResume";
import { compileTypst } from "@/lib/documents/typst";
import { evaluatePdfLayoutQa, evaluateResumeFormatPreservation } from "@/lib/documents/layoutQa";
import { extractPdfText } from "@/lib/pdf";

/**
 * Why a résumé failed layout QA, without a database.
 *
 * Document QA reports mismatches as prose for the person whose résumé was
 * rejected — "found 2 pages", "missing master font(s)". That is the right
 * output for them and the wrong one for working out why a given machine or a
 * given tailoring produces a different PDF from the same template.
 *
 * This compiles the résumé directly and prints the page counts, layout metrics
 * and every QA issue beside the reference's, so a font, a Typst version or a
 * content difference is visible rather than inferred. It touches no user data
 * and needs no database.
 *
 * Both variants are compiled on purpose. Tailoring substitutes longer phrasings
 * for the requirements a posting supports, so a master résumé that fits on one
 * page is not evidence that a tailored one does — and the tailored one is what
 * an employer receives.
 *
 *   npx tsx scripts/inspect-document-layout.ts
 */

const OUTPUT_DIR = path.join("data", "generated", "diagnostics", "layout-inspection");

const HEADER = {
  fullName: "Layout Inspection",
  email: "layout-inspection@example.test",
  phone: "+1 201 555 0100",
  linkedin: "https://www.linkedin.com/in/layout-inspection/",
  workAuthorization: "Authorized to work in the United States",
  addressCity: "Newark",
  addressState: "NJ",
};

/** The posting the tailoring path has a dedicated branch for. */
const TAILORING_JOB = {
  title: "Manufacturing Engineering Intern",
  company: "Layout Inspection Lightship",
  description:
    "Hands-on assembly planning, electronics and sensor integration, enclosure design and 3D printing, hardware diagnostics and component replacement, and CAD work in a collaborative production environment.",
};

const TAILORING_FACTS = [
  { id: "fact-pc", type: "experience", content: "PC Builder and Repair Technician", detail: "PC assembly, diagnostics, and component replacement." },
  { id: "fact-air", type: "project", content: "Air Quality Monitor", detail: "3D printing and enclosure design for the sensor, display and electronics." },
  { id: "fact-cad", type: "skill", content: "SolidWorks", detail: "CAD modelling." },
  { id: "fact-sensor", type: "skill", content: "Circuit prototyping", detail: "OLED integration and analog sensor interfacing." },
];

async function inspect(label: string, source: string): Promise<number> {
  const sourcePath = path.join(OUTPUT_DIR, `${label}.typ`);
  const pdfPath = path.join(OUTPUT_DIR, `${label}.pdf`);
  await writeFile(path.resolve(sourcePath), source, "utf8");

  const compiled = await compileTypst(path.resolve(sourcePath), path.resolve(pdfPath), process.cwd());
  console.log(`[${label}] typst compile ok=${compiled.ok}`);
  if (!compiled.ok) {
    console.error(compiled.stderr);
    return 1;
  }

  const generatedBytes = new Uint8Array(await readFile(path.resolve(pdfPath)));
  const referenceBytes = new Uint8Array(await readFile(path.resolve("templates/master_resume_reference.pdf")));
  const [generatedText, referenceText] = await Promise.all([
    extractPdfText(generatedBytes),
    extractPdfText(referenceBytes),
  ]);
  console.log(`[${label}] generated pages: ${generatedText.pageCount}, reference pages: ${referenceText.pageCount}`);

  const layout = await evaluatePdfLayoutQa(generatedBytes, "resume");
  console.log(`[${label}] layout pages: ${layout.pageCount}, metrics: ${JSON.stringify(layout.metrics)}`);
  for (const issue of layout.issues) console.log(`  [${label}] layout: ${issue}`);

  const format = await evaluateResumeFormatPreservation(generatedBytes, referenceBytes);
  console.log(`[${label}] format status: ${format.status}`);
  for (const issue of format.issues) console.log(`  [${label}] format: ${issue}`);

  return layout.issues.length + format.issues.length;
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const masterIssues = await inspect("master", buildMasterResumeSource(HEADER));
  const tailored = tailoredMasterContent(TAILORING_JOB, TAILORING_FACTS);
  const tailoredIssues = await inspect("tailored", buildMasterResumeSource(HEADER, tailored.content));

  console.log(`\nWrote ${OUTPUT_DIR} for inspection.`);

  // Only the master is a pass/fail question about this machine. A tailored
  // résumé that runs long is a fact about the content — true on every machine —
  // and document generation answers it by falling back to the untailored
  // master rather than failing, so it is reported rather than gated.
  if (tailoredIssues > 0) {
    console.log(
      `\nNote: the tailored variant does not fit the master format (${tailoredIssues} issue(s)). `
      + "Generation falls back to the untailored master résumé in that case; see generateDocumentsForJob.",
    );
  }
  if (masterIssues > 0) {
    console.error(
      `This machine does not reproduce the master résumé format: ${masterIssues} issue(s) above. `
      + "Every résumé it generates would be rejected by document QA.",
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
