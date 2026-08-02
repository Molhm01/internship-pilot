import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { existsSync } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

async function makeResumePdf(pages: string[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    let y = 740;
    for (const line of lines) {
      if (line) page.drawText(line, { x: 50, y, size: 12, font, color: rgb(0, 0, 0) });
      y -= 20;
    }
  }
  return doc.save();
}

async function makeScannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 50, y: 50, width: 400, height: 600, color: rgb(0.8, 0.8, 0.8) });
  return doc.save();
}

function upload(bytes: Uint8Array, filename: string, type = "application/pdf") {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(bytes)], { type }), filename);
  return fetch(`${BASE_URL}/api/resume/upload`, { method: "POST", body: formData });
}

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function main() {
  console.log("1) Valid single-page resume PDF");
  const validPdf = await makeResumePdf([
    [
      "Jamie Rivera",
      "B.S. in Computer Science, State University",
      "GPA: 3.7",
      "Skills: Python, SQL, Git",
    ],
  ]);
  const validRes = await upload(validPdf, "resume.pdf");
  const validData = await validRes.json();
  check(validRes.status === 201, `status 201 (got ${validRes.status})`);
  check(validData.document?.status === "ok", `document status is "ok" (got ${validData.document?.status})`);
  check(validData.document?.pageCount === 1, `pageCount is 1 (got ${validData.document?.pageCount})`);
  check(
    validData.document?.extractedText?.includes("Jamie Rivera"),
    "extracted text contains resume content",
  );
  check(
    validData.document?.extractedText?.includes("Skills: Python, SQL, Git"),
    "extracted text preserves line content",
  );
  if (validData.document?.id) {
    const storageRoot = process.env.RESUME_STORAGE_DIR ?? path.join("data", "resumes");
    const storagePath = path.isAbsolute(storageRoot)
      ? path.join(storageRoot, `${validData.document.id}.pdf`)
      : path.join(process.cwd(), storageRoot, `${validData.document.id}.pdf`);
    check(existsSync(storagePath), `original PDF saved to local data folder at ${storagePath}`);
  }

  console.log("\n2) Non-PDF file (plain text renamed with wrong content)");
  const nonPdfRes = await upload(
    new TextEncoder().encode("This is just a text file, not a PDF."),
    "notes.txt",
    "text/plain",
  );
  const nonPdfData = await nonPdfRes.json();
  check(nonPdfRes.status === 400, `status 400 (got ${nonPdfRes.status})`);
  check(!!nonPdfData.error, `error message present: "${nonPdfData.error}"`);

  console.log("\n3) File renamed to .pdf but not actually a PDF (magic-byte check)");
  const fakePdfRes = await upload(
    new TextEncoder().encode("Not a real PDF, just renamed."),
    "fake.pdf",
  );
  const fakePdfData = await fakePdfRes.json();
  check(fakePdfRes.status === 400, `status 400 (got ${fakePdfRes.status})`);
  check(!!fakePdfData.error, `error message present: "${fakePdfData.error}"`);

  console.log("\n4) PDF larger than 10 MB");
  const bigBytes = new Uint8Array(11 * 1024 * 1024);
  bigBytes.set(new TextEncoder().encode("%PDF-1.4\n"), 0);
  const bigRes = await upload(bigBytes, "big-resume.pdf");
  const bigData = await bigRes.json();
  check(bigRes.status === 400, `status 400 (got ${bigRes.status})`);
  check(/10 ?MB/.test(bigData.error ?? ""), `error mentions 10 MB limit: "${bigData.error}"`);

  console.log("\n5) Multi-page PDF (3 pages)");
  const multiPdf = await makeResumePdf([
    ["Page one: Education", "B.S. Computer Science"],
    ["Page two: Experience", "Software Intern, Acme Corp"],
    ["Page three: Projects", "Built a scheduling app"],
  ]);
  const multiRes = await upload(multiPdf, "multi-page-resume.pdf");
  const multiData = await multiRes.json();
  check(multiRes.status === 201, `status 201 (got ${multiRes.status})`);
  check(multiData.document?.pageCount === 3, `pageCount is 3 (got ${multiData.document?.pageCount})`);
  check(multiData.document?.extractedText?.includes("Page one"), "page 1 content present");
  check(multiData.document?.extractedText?.includes("Page two"), "page 2 content present");
  check(multiData.document?.extractedText?.includes("Page three"), "page 3 content present");

  console.log("\n6) Scanned PDF with no text layer");
  const scannedPdf = await makeScannedPdf();
  const scannedRes = await upload(scannedPdf, "scanned-resume.pdf");
  const scannedData = await scannedRes.json();
  check(scannedRes.status === 201, `upload still succeeds, status 201 (got ${scannedRes.status})`);
  check(
    scannedData.document?.status === "scanned",
    `document status is "scanned" (got ${scannedData.document?.status})`,
  );
  check(
    scannedData.document?.extractedText === "",
    "extractedText is empty (not silently analyzed)",
  );

  console.log("\n7) Delete a document removes DB row and file from disk");
  if (validData.document?.id) {
    const delRes = await fetch(`${BASE_URL}/api/resume/documents/${validData.document.id}`, {
      method: "DELETE",
    });
    check(delRes.ok, `delete request succeeded (status ${delRes.status})`);
    const storageRoot = process.env.RESUME_STORAGE_DIR ?? path.join("data", "resumes");
    const storagePath = path.isAbsolute(storageRoot)
      ? path.join(storageRoot, `${validData.document.id}.pdf`)
      : path.join(process.cwd(), storageRoot, `${validData.document.id}.pdf`);
    check(!existsSync(storagePath), "file removed from local data folder");
  }

  console.log(failures === 0 ? "\nAll PDF upload tests PASSED." : `\n${failures} PDF upload test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Test script crashed:", err);
  process.exitCode = 1;
});
