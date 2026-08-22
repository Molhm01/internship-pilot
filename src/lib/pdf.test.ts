import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfText, hasPdfMagicBytes } from "./pdf";

/**
 * The caller keeps its bytes.
 *
 * pdf.js takes ownership of the typed array it is given and detaches the
 * underlying buffer while parsing. Document generation compiles a PDF, extracts
 * its text to run QA and the identity guard, and then writes those same bytes
 * to storage — so a detached buffer turned every tailored résumé into
 * "Resume persistence failed", after the expensive part had already succeeded.
 */
async function samplePdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 48, y: 720, size: 12, font });
  return pdf.save();
}

describe("PDF text extraction", () => {
  it("leaves the caller's bytes usable afterwards", async () => {
    const bytes = await samplePdf("Ada Fixture — Electrical Engineering");
    const lengthBefore = bytes.length;

    const extraction = await extractPdfText(bytes);
    expect(extraction.text).toContain("Ada Fixture");

    // Both of these throw on a detached buffer, and both are things the
    // generation pipeline does after extracting.
    expect(bytes.length).toBe(lengthBefore);
    expect(() => new Uint8Array(bytes)).not.toThrow();
    expect(hasPdfMagicBytes(bytes)).toBe(true);
    expect(Buffer.from(bytes).length).toBe(lengthBefore);
  });
});
