import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { MasterEducation, MasterEntry, MasterSkillGroup } from "@/lib/documents/masterResume";

export type FallbackResumeHeader = {
  fullName: string;
  email: string;
  phone: string;
  linkedin?: string | null;
  workAuthorization?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
};

export type FallbackResumeContent = {
  education: MasterEducation[];
  experience: MasterEntry[];
  projects: MasterEntry[];
  skills: MasterSkillGroup[];
  activities: string[];
};

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 34;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2; // 544pt, safely inside 23..589
const CONTACT_FONT_SIZE = 9.0; // Strictly >= 8.8pt layout QA floor

const INK_DARK = rgb(0.08, 0.1, 0.14);
const INK_MUTED = rgb(0.28, 0.33, 0.4);
const RULE_COLOR = rgb(0.75, 0.78, 0.84);

/**
 * Preserves standard WinAnsi punctuation (en-dash, em-dash, curly quotes, ellipsis)
 * so verbatim critical-text QA matches, while normalizing unsupported dashes/spaces.
 */
function sanitizePdfText(value: string): string {
  return value
    .replace(/[\u2010\u2011\u2012\u2015\u2212]/g, "-")
    .replace(/\u2022/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2026]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wrapTextToWidth(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const clean = sanitizePdfText(text);
  if (!clean) return [];
  const words = clean.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
        current = word;
      } else {
        // Fallback character split only if a single token is wider than the full column.
        let slice = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(slice + ch, fontSize) <= maxWidth) {
            slice += ch;
          } else {
            if (slice) lines.push(slice);
            slice = ch;
          }
        }
        current = slice;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapContactPartsToWidth(
  parts: string[],
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  const cleanParts = parts.map(sanitizePdfText).filter(Boolean);
  if (!cleanParts.length) return [];
  const separator = " | ";
  const lines: string[] = [];
  let current = "";

  for (const part of cleanParts) {
    const candidate = current ? `${current}${separator}${part}` : part;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(part, fontSize) <= maxWidth) {
        current = part;
      } else {
        const wrapped = wrapTextToWidth(part, font, fontSize, maxWidth);
        if (wrapped.length > 1) {
          lines.push(...wrapped.slice(0, -1));
        }
        current = wrapped.at(-1) ?? "";
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

type ResumeOp =
  | { kind: "header"; nameLines: string[]; nameSize: number; contactLines: string[] }
  | { kind: "section"; title: string }
  | { kind: "row"; leftLines: string[]; leftFont: "bold" | "italic"; right: string; fontSize: number }
  | { kind: "bullet"; lines: string[]; fontSize: number }
  | { kind: "text"; lines: string[]; fontSize: number }
  | { kind: "spacer"; height: number };

function buildResumeOps(
  header: FallbackResumeHeader,
  content: FallbackResumeContent,
  fontRegular: PDFFont,
  fontBold: PDFFont,
  fontItalic: PDFFont,
  scale: { bodySize: number; lineGap: number; sectionGap: number; itemGap: number },
): { ops: ResumeOp[]; totalHeight: number } {
  const ops: ResumeOp[] = [];
  const location = [header.addressCity, header.addressState]
    .filter((v): v is string => Boolean(v?.trim()))
    .join(", ") || "NYC Metro Area";
  const contactParts = [location, header.email, header.phone, header.linkedin, header.workAuthorization]
    .filter((v): v is string => Boolean(v?.trim()))
    .map(sanitizePdfText);
  const contactLines = wrapContactPartsToWidth(contactParts, fontRegular, CONTACT_FONT_SIZE, CONTENT_WIDTH);

  const cleanName = sanitizePdfText(header.fullName) || "Candidate";
  let nameSize = 15;
  while (nameSize > 11 && fontBold.widthOfTextAtSize(cleanName, nameSize) > CONTENT_WIDTH) {
    nameSize -= 0.5;
  }
  const nameLines = wrapTextToWidth(cleanName, fontBold, nameSize, CONTENT_WIDTH);

  ops.push({ kind: "header", nameLines, nameSize, contactLines });

  const addSection = (title: string) => {
    ops.push({ kind: "spacer", height: scale.sectionGap });
    ops.push({ kind: "section", title });
  };

  const makeRowOp = (
    leftRaw: string,
    leftFontKind: "bold" | "italic",
    rightRaw: string,
    fontSize: number,
  ): ResumeOp => {
    const leftFont = leftFontKind === "bold" ? fontBold : fontItalic;
    const right = sanitizePdfText(rightRaw);
    const rightWidth = right ? fontRegular.widthOfTextAtSize(right, fontSize) : 0;
    const safeMaxLeft = right ? Math.max(140, CONTENT_WIDTH - rightWidth - 14) : CONTENT_WIDTH;
    const leftLines = wrapTextToWidth(leftRaw, leftFont, fontSize, safeMaxLeft);
    return { kind: "row", leftLines, leftFont: leftFontKind, right, fontSize };
  };

  if (content.education.length) {
    addSection("EDUCATION");
    for (const edu of content.education) {
      ops.push(makeRowOp(edu.school, "bold", edu.location, scale.bodySize + 0.5));
      ops.push(makeRowOp(edu.degree, "italic", edu.dates, scale.bodySize));
      if (edu.coursework?.trim()) {
        const cwLines = wrapTextToWidth(`Relevant Coursework: ${sanitizePdfText(edu.coursework)}`, fontRegular, scale.bodySize, CONTENT_WIDTH);
        ops.push({ kind: "text", lines: cwLines, fontSize: scale.bodySize });
      }
      ops.push({ kind: "spacer", height: scale.itemGap });
    }
  }

  if (content.experience.length) {
    addSection("EXPERIENCE");
    for (const exp of content.experience) {
      ops.push(makeRowOp(exp.organization, "bold", exp.location, scale.bodySize + 0.5));
      ops.push(makeRowOp(exp.title, "italic", exp.dates, scale.bodySize));
      for (const bullet of exp.bullets) {
        const bLines = wrapTextToWidth(bullet, fontRegular, scale.bodySize, CONTENT_WIDTH - 16);
        if (bLines.length) ops.push({ kind: "bullet", lines: bLines, fontSize: scale.bodySize });
      }
      ops.push({ kind: "spacer", height: scale.itemGap });
    }
  }

  if (content.projects.length) {
    addSection("PROJECTS");
    for (const proj of content.projects) {
      const right = sanitizePdfText(proj.dates || proj.location);
      ops.push(makeRowOp(proj.title, "bold", right, scale.bodySize + 0.5));
      if (proj.organization?.trim()) {
        ops.push(makeRowOp(proj.organization, "italic", "", scale.bodySize));
      }
      for (const bullet of proj.bullets) {
        const bLines = wrapTextToWidth(bullet, fontRegular, scale.bodySize, CONTENT_WIDTH - 16);
        if (bLines.length) ops.push({ kind: "bullet", lines: bLines, fontSize: scale.bodySize });
      }
      ops.push({ kind: "spacer", height: scale.itemGap });
    }
  }

  if (content.skills.length) {
    addSection("SKILLS");
    for (const group of content.skills) {
      const text = `${sanitizePdfText(group.label)}: ${group.items.map(sanitizePdfText).filter(Boolean).join(", ")}`;
      const lines = wrapTextToWidth(text, fontRegular, scale.bodySize, CONTENT_WIDTH);
      if (lines.length) ops.push({ kind: "text", lines, fontSize: scale.bodySize });
    }
  }

  if (content.activities.length) {
    addSection("ACTIVITIES & LEADERSHIP");
    for (const act of content.activities) {
      const lines = wrapTextToWidth(act, fontRegular, scale.bodySize, CONTENT_WIDTH - 16);
      if (lines.length) ops.push({ kind: "bullet", lines, fontSize: scale.bodySize });
    }
  }

  let height = 0;
  for (const op of ops) {
    if (op.kind === "header") {
      height += op.nameLines.length * (op.nameSize + 2) + op.contactLines.length * scale.lineGap + 4;
    } else if (op.kind === "section") height += 15;
    else if (op.kind === "row") height += Math.max(1, op.leftLines.length) * scale.lineGap;
    else if (op.kind === "bullet") height += op.lines.length * scale.lineGap;
    else if (op.kind === "text") height += op.lines.length * scale.lineGap;
    else if (op.kind === "spacer") height += op.height;
  }
  return { ops, totalHeight: height };
}

/**
 * Generates a single-page Letter resume PDF purely in JavaScript using pdf-lib,
 * calibrated to satisfy strict margin, font-size, line-gap, collision, and
 * full-page vertical utilization QA requirements in both cloud and local runtimes.
 */
export async function compileResumePdfFallback(
  header: FallbackResumeHeader,
  content: FallbackResumeContent,
  outPdfPath: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  // Target total height roughly 630..700pt inside y = 756..40 (so bottom y is <= 135pt)
  const topY = 756;
  const maxUsableHeight = topY - 40; // 716pt max height to stay strictly >= y=40

  const candidates = [
    { bodySize: 9.5, lineGap: 11.8, sectionGap: 10, itemGap: 5 },
    { bodySize: 9.2, lineGap: 11.2, sectionGap: 8, itemGap: 3.5 },
    { bodySize: 9.0, lineGap: 10.6, sectionGap: 6, itemGap: 2 },
    { bodySize: 8.9, lineGap: 10.0, sectionGap: 5, itemGap: 1.5 },
  ];

  let chosenScale = candidates[0];
  let chosen = buildResumeOps(header, content, fontRegular, fontBold, fontItalic, chosenScale);
  for (const preset of candidates) {
    const measured = buildResumeOps(header, content, fontRegular, fontBold, fontItalic, preset);
    chosen = measured;
    chosenScale = preset;
    if (measured.totalHeight <= maxUsableHeight) {
      if (measured.totalHeight < 625) {
        const spacerCount = measured.ops.filter((op) => op.kind === "spacer").length || 1;
        const extraPerSpacer = Math.min(36, (660 - measured.totalHeight) / spacerCount);
        chosenScale = {
          bodySize: preset.bodySize,
          lineGap: Math.min(13.8, preset.lineGap + 1.2),
          sectionGap: preset.sectionGap + extraPerSpacer * 0.7,
          itemGap: preset.itemGap + extraPerSpacer * 0.3,
        };
        chosen = buildResumeOps(header, content, fontRegular, fontBold, fontItalic, chosenScale);
      }
      break;
    }
  }

  const page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = topY;
  const lineStep = chosenScale.lineGap;

  for (const op of chosen.ops) {
    if (y < 24) break;
    if (op.kind === "header") {
      for (const nameLine of op.nameLines) {
        const nameWidth = fontBold.widthOfTextAtSize(nameLine, op.nameSize);
        const nameX = Math.max(MARGIN_X, (PAGE_WIDTH - nameWidth) / 2);
        page.drawText(nameLine, { x: nameX, y, size: op.nameSize, font: fontBold, color: INK_DARK });
        y -= op.nameSize + 1;
      }
      y -= 1;
      for (const line of op.contactLines) {
        const w = fontRegular.widthOfTextAtSize(line, CONTACT_FONT_SIZE);
        const cx = Math.max(MARGIN_X, (PAGE_WIDTH - w) / 2);
        page.drawText(line, { x: cx, y, size: CONTACT_FONT_SIZE, font: fontRegular, color: INK_MUTED });
        y -= lineStep;
      }
      y -= 2;
    } else if (op.kind === "section") {
      page.drawText(op.title, { x: MARGIN_X, y, size: 10.5, font: fontBold, color: INK_DARK });
      page.drawLine({
        start: { x: MARGIN_X, y: y - 3 },
        end: { x: PAGE_WIDTH - MARGIN_X, y: y - 3 },
        thickness: 0.65,
        color: RULE_COLOR,
      });
      y -= 15;
    } else if (op.kind === "row") {
      const leftFont = op.leftFont === "bold" ? fontBold : fontItalic;
      const rightText = op.right;
      const rightWidth = rightText ? fontRegular.widthOfTextAtSize(rightText, op.fontSize) : 0;
      if (op.leftLines.length) {
        page.drawText(op.leftLines[0], { x: MARGIN_X, y, size: op.fontSize, font: leftFont, color: INK_DARK });
      }
      if (rightText) {
        page.drawText(rightText, {
          x: PAGE_WIDTH - MARGIN_X - rightWidth,
          y,
          size: op.fontSize,
          font: fontRegular,
          color: INK_MUTED,
        });
      }
      y -= lineStep;
      for (let i = 1; i < op.leftLines.length; i++) {
        if (y < 24) break;
        page.drawText(op.leftLines[i], { x: MARGIN_X, y, size: op.fontSize, font: leftFont, color: INK_DARK });
        y -= lineStep;
      }
    } else if (op.kind === "bullet") {
      op.lines.forEach((line, idx) => {
        if (y < 24) return;
        if (idx === 0) {
          page.drawText("-", { x: MARGIN_X + 6, y, size: op.fontSize, font: fontBold, color: INK_DARK });
        }
        page.drawText(line, { x: MARGIN_X + 16, y, size: op.fontSize, font: fontRegular, color: INK_DARK });
        y -= lineStep;
      });
    } else if (op.kind === "text") {
      for (const line of op.lines) {
        if (y < 24) break;
        page.drawText(line, { x: MARGIN_X, y, size: op.fontSize, font: fontRegular, color: INK_DARK });
        y -= lineStep;
      }
    } else if (op.kind === "spacer") {
      y -= op.height;
    }
  }

  const bytes = await doc.save();
  await mkdir(path.dirname(outPdfPath), { recursive: true });
  await writeFile(outPdfPath, bytes);
  return bytes;
}

export async function compileCoverLetterPdfFallback(
  opts: {
    name: string;
    contact: string[];
    date: string;
    company: string;
    jobTitle: string;
    paragraphs: string[];
  },
  outPdfPath: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const marginX = 54;
  const maxWidth = PAGE_WIDTH - marginX * 2; // 504pt
  let y = 746;

  // Name & Contact header
  const cleanName = sanitizePdfText(opts.name) || "Candidate";
  for (const nameLine of wrapTextToWidth(cleanName, fontBold, 15, maxWidth)) {
    page.drawText(nameLine, { x: marginX, y, size: 15, font: fontBold, color: INK_DARK });
    y -= 17;
  }

  for (const line of wrapContactPartsToWidth(opts.contact, fontRegular, 9.5, maxWidth)) {
    page.drawText(line, { x: marginX, y, size: 9.5, font: fontRegular, color: INK_MUTED });
    y -= 13;
  }

  y -= 4;
  page.drawLine({
    start: { x: marginX, y },
    end: { x: PAGE_WIDTH - marginX, y },
    thickness: 0.65,
    color: RULE_COLOR,
  });
  y -= 20;

  // Date & Recipient
  for (const dateLine of wrapTextToWidth(opts.date, fontRegular, 10.5, maxWidth)) {
    page.drawText(dateLine, { x: marginX, y, size: 10.5, font: fontRegular, color: INK_DARK });
    y -= 16;
  }
  for (const companyLine of wrapTextToWidth(opts.company, fontBold, 10.5, maxWidth)) {
    page.drawText(companyLine, { x: marginX, y, size: 10.5, font: fontBold, color: INK_DARK });
    y -= 15;
  }
  y -= 9;

  for (const greetingLine of wrapTextToWidth(`Dear ${opts.company} Hiring Team,`, fontRegular, 10.5, maxWidth)) {
    page.drawText(greetingLine, {
      x: marginX,
      y,
      size: 10.5,
      font: fontRegular,
      color: INK_DARK,
    });
    y -= 15;
  }
  y -= 5;

  // Helper to wrap paragraph while keeping exact jobTitle phrase unbroken when possible
  const drawParagraph = (para: string) => {
    const clean = sanitizePdfText(para);
    const titleToken = sanitizePdfText(opts.jobTitle);
    const lines: string[] = [];

    if (titleToken && clean.includes(titleToken) && fontRegular.widthOfTextAtSize(titleToken, 10.5) <= maxWidth) {
      const idx = clean.indexOf(titleToken);
      const before = clean.slice(0, idx).trim();
      const rawAfter = clean.slice(idx + titleToken.length);
      const punctMatch = rawAfter.match(/^([.,!?;:)\]]+)(.*)$/);
      const pinnedToken = punctMatch && fontRegular.widthOfTextAtSize(`${titleToken}${punctMatch[1]}`, 10.5) <= maxWidth
        ? `${titleToken}${punctMatch[1]}`
        : titleToken;
      const after = (pinnedToken !== titleToken && punctMatch ? punctMatch[2] : rawAfter).trim();
      const beforeWords = before ? before.split(" ") : [];
      const afterWords = after ? after.split(" ") : [];
      const tokens = [...beforeWords, pinnedToken, ...afterWords];
      let current = "";
      for (const token of tokens) {
        const candidate = current ? `${current} ${token}` : token;
        if (fontRegular.widthOfTextAtSize(candidate, 10.5) <= maxWidth) {
          current = candidate;
        } else {
          if (current) lines.push(current);
          if (fontRegular.widthOfTextAtSize(token, 10.5) <= maxWidth) {
            current = token;
          } else {
            const wrapped = wrapTextToWidth(token, fontRegular, 10.5, maxWidth);
            lines.push(...wrapped.slice(0, -1));
            current = wrapped.at(-1) ?? "";
          }
        }
      }
      if (current) lines.push(current);
    } else {
      lines.push(...wrapTextToWidth(clean, fontRegular, 10.5, maxWidth));
    }

    for (const line of lines) {
      if (y < 60) break;
      page.drawText(line, { x: marginX, y, size: 10.5, font: fontRegular, color: INK_DARK });
      y -= 14.5;
    }
    y -= 10;
  };

  for (const para of opts.paragraphs) {
    drawParagraph(para);
  }

  y -= 6;
  if (y >= 40) {
    page.drawText("Sincerely,", { x: marginX, y, size: 10.5, font: fontRegular, color: INK_DARK });
    y -= 18;
  }
  for (const sigLine of wrapTextToWidth(cleanName, fontBold, 10.5, maxWidth)) {
    if (y < 24) break;
    page.drawText(sigLine, { x: marginX, y, size: 10.5, font: fontBold, color: INK_DARK });
    y -= 14;
  }

  const bytes = await doc.save();
  await mkdir(path.dirname(outPdfPath), { recursive: true });
  await writeFile(outPdfPath, bytes);
  return bytes;
}

