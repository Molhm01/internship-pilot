import { PDFParse } from "pdf-parse";

export const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;

// The first 5 bytes of every valid PDF file are the literal ASCII "%PDF-".
// Checking this (rather than trusting the browser-supplied MIME type or file
// extension) means a renamed .docx/.jpg is rejected even if someone changes
// its extension to .pdf.
const PDF_MAGIC = "%PDF-";

export function hasPdfMagicBytes(bytes: Uint8Array): boolean {
  const header = Buffer.from(bytes.subarray(0, 5)).toString("ascii");
  return header === PDF_MAGIC;
}

export class PdfExtractionError extends Error {}

export type PdfExtractionResult = {
  text: string;
  pageCount: number;
  scanned: boolean;
};

// Below this many non-whitespace characters total, we treat the PDF as
// having no usable text layer (scanned/image-only) rather than silently
// handing near-empty text to the AI model.
const MIN_TEXT_LENGTH = 20;

export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtractionResult> {
  let parser: PDFParse;
  try {
    parser = new PDFParse({ data: bytes });
  } catch (err) {
    throw new PdfExtractionError(
      `Could not open this PDF. It may be corrupted. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  try {
    const result = await parser.getText();
    const text = result.pages
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join("\n\n");

    return {
      text,
      pageCount: result.total,
      scanned: text.trim().length < MIN_TEXT_LENGTH,
    };
  } catch (err) {
    throw new PdfExtractionError(
      `Could not read this PDF. It may be corrupted or password-protected. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  } finally {
    await parser.destroy();
  }
}
