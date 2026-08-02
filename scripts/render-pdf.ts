import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";

async function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) throw new Error("Usage: tsx scripts/render-pdf.ts <input.pdf> <output.png>");
  const parser = new PDFParse({ data: new Uint8Array(await readFile(path.resolve(input))) });
  try {
    const result = await parser.getScreenshot({ first: 1, desiredWidth: 1530, imageBuffer: true });
    const image = result.pages[0]?.data;
    if (!image) throw new Error("PDF did not render a first page.");
    await writeFile(path.resolve(output), image);
  } finally {
    await parser.destroy();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
