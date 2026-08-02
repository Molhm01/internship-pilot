import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { prisma } from "@/lib/db";

type CapturedDescription = {
  sourceUrl: string;
  title: string;
  company: string;
  location: string;
  description: string;
  responsibilities: string[];
  qualifications: string[];
  hash: string;
  capturedAt: Date;
};

function decodeHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/h\d>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function lines(value: string): string[] {
  return decodeHtml(value).split(/\n+/).map((line) => line.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
}

function leverParts(url: string): { tenant: string; postingId: string } | null {
  const match = new URL(url).pathname.match(/^\/([^/]+)\/([a-f0-9-]{20,})(?:\/apply)?\/?$/i);
  return match ? { tenant: match[1], postingId: match[2] } : null;
}

async function captureLever(job: { title: string; company: string; location: string | null; url: string }): Promise<CapturedDescription> {
  const parts = leverParts(job.url);
  if (!parts) throw new Error("The official Lever URL could not be parsed.");
  const apiUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(parts.tenant)}/${encodeURIComponent(parts.postingId)}`;
  const response = await fetch(apiUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Lever returned HTTP ${response.status} while capturing the official description.`);
  const posting = await response.json() as {
    text?: string;
    descriptionPlain?: string;
    description?: string;
    additionalPlain?: string;
    openingPlain?: string;
    descriptionBodyPlain?: string;
    categories?: { location?: string };
    lists?: Array<{ text?: string; content?: string }>;
  };
  const sections = (posting.lists ?? []).map((section) => ({ heading: section.text?.trim() ?? "", items: lines(section.content ?? "") }));
  let responsibilities = sections.filter((section) => /responsibilit|what you.ll do|role/i.test(section.heading)).flatMap((section) => section.items);
  let qualifications = sections.filter((section) => /qualification|requirement|what you.ll bring|experience/i.test(section.heading)).flatMap((section) => section.items);
  const modernBody = posting.descriptionBodyPlain?.trim() ?? "";
  if ((!responsibilities.length || !qualifications.length) && modernBody) {
    const modern = parseLeverPlainSections(modernBody);
    if (!responsibilities.length) responsibilities = modern.responsibilities;
    if (!qualifications.length) qualifications = modern.qualifications;
  }
  const description = [
    decodeHtml(posting.openingPlain ?? posting.descriptionPlain ?? posting.description ?? ""),
    modernBody,
    ...sections.map((section) => `${section.heading}\n${section.items.map((item) => `- ${item}`).join("\n")}`),
    decodeHtml(posting.additionalPlain ?? ""),
  ].filter(Boolean).join("\n\n").trim();
  const capturedAt = new Date();
  return {
    sourceUrl: job.url,
    title: posting.text?.trim() || job.title,
    company: job.company,
    location: posting.categories?.location?.trim() || job.location || "",
    description,
    responsibilities,
    qualifications,
    hash: createHash("sha256").update(description).digest("hex"),
    capturedAt,
  };
}

function parseLeverPlainSections(value: string): { responsibilities: string[]; qualifications: string[] } {
  const rawLines = value
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const qualificationStart = rawLines.findIndex((line) =>
    /^(candidate requirements|required knowledge|qualifications?|requirements?|preferred skills|background experiences?)\s*:?\s*$/i.test(line),
  );
  const boundary = qualificationStart >= 0 ? qualificationStart : rawLines.length;
  const bulletText = (line: string) => line.replace(/^[•·*-]\s*/, "").trim();
  const isBullet = (line: string) => /^[•·*-]\s*\S/.test(line);
  return {
    responsibilities: Array.from(new Set(rawLines.slice(0, boundary).filter(isBullet).map(bulletText))),
    qualifications: Array.from(new Set(rawLines.slice(boundary).filter(isBullet).map(bulletText))),
  };
}

async function captureGeneric(job: { title: string; company: string; location: string | null; url: string }): Promise<CapturedDescription> {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const response = await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (response && response.status() >= 400) {
      throw new Error(`Official job page returned HTTP ${response.status()}.`);
    }
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await page.addScriptTag({
      path: path.join(process.cwd(), "extension", "dist", "page-reader.js"),
    });
    const captured = await page.evaluate(async () => {
      const scope = globalThis as unknown as {
        InternshipPilotPageReader?: {
          readJobDescription: () => Promise<{
            sourceUrl: string;
            title: string;
            description: string;
            responsibilities: string[];
            qualifications: string[];
            capturedAt: string;
          }>;
        };
      };
      if (!scope.InternshipPilotPageReader) throw new Error("The extension DOM description reader did not load.");
      return scope.InternshipPilotPageReader.readJobDescription();
    });
    const description = captured.description.trim();
    const capturedAt = new Date(captured.capturedAt);
    return {
      sourceUrl: captured.sourceUrl || page.url(),
      title: captured.title || job.title,
      company: job.company,
      location: job.location ?? "",
      description,
      responsibilities: captured.responsibilities,
      qualifications: captured.qualifications,
      hash: createHash("sha256").update(description).digest("hex"),
      capturedAt: Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export function hasCompleteJobDescription(job: {
  description: string;
  jobDescriptionHash: string | null;
  jobDescriptionCapturedAt: Date | null;
  jobDescriptionSourceUrl?: string | null;
  jobResponsibilities?: string | null;
  jobQualifications?: string | null;
}): boolean {
  return Boolean(
    job.jobDescriptionHash
    && job.jobDescriptionCapturedAt
    && job.jobDescriptionSourceUrl
    && job.description.trim().length >= 500
    && !/\.\.\.\s*$/.test(job.description.trim())
    && parseSavedItems(job.jobResponsibilities).length > 0
    && parseSavedItems(job.jobQualifications).length > 0,
  );
}

export async function captureAndSaveOfficialJobDescription(jobId: string): Promise<CapturedDescription> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  const sourceUrl = job?.officialJobUrl ?? job?.url ?? job?.officialApplyUrl;
  if (!job || !sourceUrl) throw new Error("No official job URL is saved.");
  const parsedUrl = new URL(sourceUrl);
  const localTestUrl = process.env.ISOLATED_TEST_MODE === "1"
    && parsedUrl.protocol === "http:"
    && ["localhost", "127.0.0.1"].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !localTestUrl) throw new Error("The official job-description URL must use HTTPS.");
  const captured = /jobs\.lever\.co$/i.test(parsedUrl.hostname)
    ? await captureLever({ ...job, url: sourceUrl })
    : await captureGeneric({ ...job, url: sourceUrl });
  if (captured.description.length < 500) throw new Error("The complete visible job description could not be captured.");
  if (!captured.responsibilities.length || !captured.qualifications.length) {
    throw new Error("The official posting did not expose complete Responsibilities and Qualifications sections.");
  }
  await prisma.job.update({
    where: { id: jobId },
    data: {
      title: captured.title,
      location: captured.location || job.location,
      description: captured.description,
      jobDescriptionSourceUrl: captured.sourceUrl,
      jobDescriptionHash: captured.hash,
      jobDescriptionCapturedAt: captured.capturedAt,
      jobResponsibilities: JSON.stringify(captured.responsibilities),
      jobQualifications: JSON.stringify(captured.qualifications),
    },
  });
  return captured;
}

function parseSavedItems(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}
