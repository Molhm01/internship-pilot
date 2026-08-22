import "dotenv/config";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildMasterResumeSource } from "@/lib/documents/generate";
import { compileTypst } from "@/lib/documents/typst";
import { evaluatePdfLayoutQa, evaluateResumeFormatPreservation } from "@/lib/documents/layoutQa";
import { extractPdfText } from "@/lib/pdf";

/**
 * Why a résumé failed layout QA, without a database.
 *
 * Document QA compares each compiled résumé with
 * `templates/master_resume_reference.pdf` — page count, margins, fonts, font
 * sizes and line spacing — and reports the mismatches as prose. That is the
 * right output for someone whose résumé was rejected, and the wrong output for
 * working out *why* a machine produces a different PDF from the same template:
 * "found 2 pages" does not say which font substituted or where the extra
 * height came from.
 *
 * This compiles the master résumé directly and prints both snapshots side by
 * side, so a font, a Typst version or a metric difference between two machines
 * is visible rather than inferred. It touches no user data and needs no
 * database.
 *
 *   npx tsx scripts/inspect-document-layout.ts
 */

const OUTPUT_DIR = path.join("data", "generated", "diagnostics", "layout-inspection");

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const sourcePath = path.join(OUTPUT_DIR, "master.typ");
  const pdfPath = path.join(OUTPUT_DIR, "master.pdf");

  const source = buildMasterResumeSource({
    fullName: "Layout Inspection",
    email: "layout-inspection@example.test",
    phone: "+1 201 555 0100",
    linkedin: "https://www.linkedin.com/in/layout-inspection/",
    workAuthorization: "Authorized to work in the United States",
    addressCity: "Newark",
    addressState: "NJ",
  });
  await writeFile(path.resolve(sourcePath), source, "utf8");

  const compiled = await compileTypst(path.resolve(sourcePath), path.resolve(pdfPath), process.cwd());
  console.log(`typst compile ok=${compiled.ok}`);
  if (!compiled.ok) {
    console.error(compiled.stderr);
    process.exitCode = 1;
    return;
  }

  const generatedBytes = new Uint8Array(await readFile(path.resolve(pdfPath)));
  const referenceBytes = new Uint8Array(await readFile(path.resolve("templates/master_resume_reference.pdf")));

  const [generatedText, referenceText] = await Promise.all([
    extractPdfText(generatedBytes),
    extractPdfText(referenceBytes),
  ]);
  console.log(`generated pages: ${generatedText.pageCount}`);
  console.log(`reference pages: ${referenceText.pageCount}`);

  const layout = await evaluatePdfLayoutQa(generatedBytes, "resume");
  console.log(`layout QA pages: ${layout.pageCount}, metrics: ${JSON.stringify(layout.metrics)}`);
  for (const issue of layout.issues) console.log(`  layout: ${issue}`);

  const format = await evaluateResumeFormatPreservation(generatedBytes, referenceBytes);
  console.log(`format QA status: ${format.status}`);
  for (const issue of format.issues) console.log(`  format: ${issue}`);

  console.log(`\nWrote ${pdfPath} for inspection.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
