type PdfTextBox = { text: string; x: number; y: number; width: number; height: number };

export type PdfLayoutQaResult = {
  pageCount: number;
  issues: string[];
  metrics: { minTextY: number; maxTextY: number; minimumFontHeight: number };
};

function overlaps(a: PdfTextBox, b: PdfTextBox) {
  const horizontal = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return horizontal > 0.8 && vertical > 0.8;
}

/** Geometry checks which cannot be inferred from extracted plain text. */
export async function evaluatePdfLayoutQa(bytes: Uint8Array, kind: "resume" | "coverLetter"): Promise<PdfLayoutQaResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: bytes.slice(), disableWorker: true } as never).promise;
  const issues: string[] = [];
  const boxes: PdfTextBox[] = [];
  let pageWidth = 0;
  let pageHeight = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pageWidth = viewport.width;
      pageHeight = viewport.height;
      const content = await page.getTextContent();
      for (const raw of content.items) {
        if (!("str" in raw) || !raw.str.trim()) continue;
        boxes.push({ text: raw.str, x: raw.transform[4], y: raw.transform[5], width: raw.width, height: raw.height });
      }
    }
  } finally {
    await document.destroy();
  }

  for (const box of boxes) {
    if (box.x < 23 || box.y < 18 || box.x + box.width > pageWidth - 23 || box.y + box.height > pageHeight - 18) {
      issues.push(`Text falls outside the safe page margin: "${box.text.slice(0, 50)}".`);
    }
  }

  for (let left = 0; left < boxes.length; left++) {
    for (let right = left + 1; right < boxes.length; right++) {
      const a = boxes[left];
      const b = boxes[right];
      if (overlaps(a, b)) {
        issues.push(`Text collision between "${a.text.slice(0, 45)}" and "${b.text.slice(0, 45)}".`);
      }
    }
  }

  const lines = new Map<number, PdfTextBox[]>();
  for (const box of boxes) {
    const key = Math.round(box.y * 2) / 2;
    lines.set(key, [...(lines.get(key) ?? []), box]);
  }
  const orderedLines = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([y, items]) => ({
    y,
    text: items.sort((a, b) => a.x - b.x).map((item) => item.text).join(" ").replace(/\s+/g, " ").trim(),
  }));
  for (let index = 1; index < orderedLines.length; index++) {
    const gap = orderedLines[index - 1].y - orderedLines[index].y;
    if (gap > 0.5 && gap < 8.5) issues.push(`Lines are excessively compressed (${gap.toFixed(1)}pt): "${orderedLines[index].text.slice(0, 60)}".`);
    if (/\w-$/.test(orderedLines[index - 1].text) && /^[a-z]/.test(orderedLines[index].text)) {
      issues.push(`Awkward word split across lines: "${orderedLines[index - 1].text.slice(-25)} ${orderedLines[index].text.slice(0, 25)}".`);
    }
  }

  const heights = boxes.map((box) => box.height).filter((height) => height > 0);
  const minimumFontHeight = heights.length ? Math.min(...heights) : 0;
  if (minimumFontHeight < 8.8) issues.push(`Font is too small (${minimumFontHeight.toFixed(1)}pt).`);
  const minTextY = boxes.length ? Math.min(...boxes.map((box) => box.y)) : pageHeight;
  const maxTextY = boxes.length ? Math.max(...boxes.map((box) => box.y + box.height)) : 0;
  // The fixed template remains comfortably readable with roughly 0.75in of
  // unused space at the bottom. The previous 85pt floor incorrectly failed a
  // complete one-page resume assembled from shorter approved facts.
  if (kind === "resume" && (minTextY > 140 || maxTextY < 745)) {
    issues.push(`One-page utilization is too sparse (text spans y=${minTextY.toFixed(1)} to ${maxTextY.toFixed(1)}pt).`);
  }

  return { pageCount: document.numPages, issues: [...new Set(issues)], metrics: { minTextY, maxTextY, minimumFontHeight } };
}

export type ResumeFormatSnapshot = {
  pageCount: number;
  pageWidth: number;
  pageHeight: number;
  minTextX: number;
  maxTextRight: number;
  fontNames: string[];
  fontHeights: number[];
  bulletXs: number[];
  dateRightEdges: number[];
  activityXs: number[];
  medianLineGap: number;
};

export type ResumeFormatQaResult = {
  status: "pass" | "fail";
  issues: string[];
  generated: ResumeFormatSnapshot;
  reference: ResumeFormatSnapshot;
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundedUnique(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value * 10) / 10))]
    .sort((left, right) => left - right);
}

async function resumeFormatSnapshot(bytes: Uint8Array): Promise<ResumeFormatSnapshot> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: bytes.slice(), disableWorker: true } as never).promise;
  const boxes: Array<PdfTextBox & { fontName: string }> = [];
  const fontNames = new Set<string>();
  let pageWidth = 0;
  let pageHeight = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pageWidth = viewport.width;
      pageHeight = viewport.height;
      const content = await page.getTextContent();
      await page.getOperatorList();
      const commonObjects = (page as unknown as {
        commonObjs: { get: (name: string) => { name?: string } };
      }).commonObjs;
      for (const raw of content.items) {
        if (!("str" in raw) || !raw.str.trim()) continue;
        boxes.push({
          text: raw.str.trim(),
          x: raw.transform[4],
          y: raw.transform[5],
          width: raw.width,
          height: raw.height,
          fontName: raw.fontName,
        });
        try {
          const resolvedName = commonObjects.get(raw.fontName).name
            ?.replace(/^[A-Z]{6}\+/, "")
            .toLowerCase();
          if (resolvedName) fontNames.add(resolvedName);
        } catch {
          fontNames.add(raw.fontName.toLowerCase());
        }
      }
    }
  } finally {
    await document.destroy();
  }

  const uniqueLines = roundedUnique(boxes.map((box) => box.y)).sort((left, right) => right - left);
  const lineGaps = uniqueLines.slice(1)
    .map((line, index) => uniqueLines[index] - line)
    .filter((gap) => gap >= 8 && gap <= 18);
  const bulletXs = boxes
    .filter((box) => /^[•●▪]$/u.test(box.text))
    .map((box) => box.x);
  const dateRightEdges = boxes
    .filter((box) => /\b(?:19|20)\d{2}\b/.test(box.text) && box.x > pageWidth / 2)
    .map((box) => box.x + box.width);
  const activityXs = boxes
    .filter((box) => /^(?:IEEE|Commuter Student Organization|Muslim Student Association)\b/.test(box.text))
    .map((box) => box.x);
  return {
    pageCount: document.numPages,
    pageWidth,
    pageHeight,
    minTextX: boxes.length ? Math.min(...boxes.map((box) => box.x)) : 0,
    maxTextRight: boxes.length ? Math.max(...boxes.map((box) => box.x + box.width)) : 0,
    fontNames: [...fontNames].sort(),
    fontHeights: roundedUnique(boxes
      .filter((box) => !/^[•●▪]$/u.test(box.text))
      .map((box) => box.height)),
    bulletXs,
    dateRightEdges,
    activityXs,
    medianLineGap: median(lineGaps),
  };
}

export function compareResumeFormatSnapshots(
  generated: ResumeFormatSnapshot,
  reference: ResumeFormatSnapshot,
): string[] {
  const issues: string[] = [];
  if (generated.pageCount !== 1) issues.push(`Master format requires one page; found ${generated.pageCount}.`);
  if (Math.abs(generated.pageWidth - reference.pageWidth) > 0.5 || Math.abs(generated.pageHeight - reference.pageHeight) > 0.5) {
    issues.push("Page size no longer matches the master résumé.");
  }
  if (Math.abs(generated.minTextX - reference.minTextX) > 4 || Math.abs(generated.maxTextRight - reference.maxTextRight) > 6) {
    issues.push("Text margins no longer match the master résumé.");
  }
  const essentialReferenceFonts = reference.fontNames.filter((font) =>
    /ibmplex|timesnewroman/i.test(font),
  );
  const missingFonts = essentialReferenceFonts.filter((font) => !generated.fontNames.includes(font));
  if (missingFonts.length) issues.push(`Unexpected font substitution; missing master font(s): ${missingFonts.join(", ")}.`);
  const missingFontHeights = reference.fontHeights.filter((height) =>
    !generated.fontHeights.some((generatedHeight) => Math.abs(generatedHeight - height) <= 0.3),
  );
  if (missingFontHeights.length) issues.push(`Master font-size profile changed: ${missingFontHeights.join(", ")}pt style(s) are missing.`);
  if (!generated.bulletXs.length || Math.abs(median(generated.bulletXs) - median(reference.bulletXs)) > 2) {
    issues.push("Bullet indentation no longer matches the master résumé.");
  }
  if (generated.bulletXs.length && Math.max(...generated.bulletXs) - Math.min(...generated.bulletXs) > 2.5) {
    issues.push("Bullet indentation is inconsistent within the generated résumé.");
  }
  if (!generated.dateRightEdges.length || Math.abs(median(generated.dateRightEdges) - median(reference.dateRightEdges)) > 6) {
    issues.push("Right-aligned dates no longer match the master résumé alignment.");
  }
  if (generated.activityXs.length < reference.activityXs.length) {
    issues.push("One or more master activity rows are missing or broken.");
  } else if (reference.activityXs.length && Math.abs(median(generated.activityXs) - median(reference.activityXs)) > 3) {
    issues.push("Activity-row indentation no longer matches the master résumé.");
  }
  if (!generated.medianLineGap || Math.abs(generated.medianLineGap - reference.medianLineGap) > 1.5) {
    issues.push("Line spacing is unusually compressed or expanded relative to the master résumé.");
  }
  return issues;
}

export async function evaluateResumeFormatPreservation(
  generatedBytes: Uint8Array,
  referenceBytes: Uint8Array,
): Promise<ResumeFormatQaResult> {
  const [generated, reference] = await Promise.all([
    resumeFormatSnapshot(generatedBytes),
    resumeFormatSnapshot(referenceBytes),
  ]);
  const issues = compareResumeFormatSnapshots(generated, reference);
  return { status: issues.length ? "fail" : "pass", issues, generated, reference };
}
