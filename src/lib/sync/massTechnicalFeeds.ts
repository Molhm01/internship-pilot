import type { AtsJob } from "@/lib/ats/types";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import { canonicalizeJobUrl, upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import { parseFirstSourceDate } from "@/lib/sync/sourceDate";
import { prisma } from "@/lib/db";

const USER_AGENT = "Mozilla/5.0 Internship-Pilot/1.0";
const SIMPLIFY_FEED =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md";
const ZAPPLY_FEED =
  "https://raw.githubusercontent.com/zapplyjobs/Internships-2027/main/README.md";

const TECHNICAL_ROLE_PATTERN = /\b(?:engineer(?:ing)?|software|developer|development|programmer|computer\s+science|data\s+scien(?:ce|tist)|machine\s+learning|artificial\s+intelligence|ai\s+(?:engineer|research|intern)|ml\s+(?:engineer|research|intern)|hardware|firmware|embedded|electrical|electronics|mechanical|aerospace|aeronautical|civil|chemical|biomedical|bioengineering|industrial\s+engineer|manufacturing|semiconductor|silicon|fpga|asic|vlsi|robotics|automation|controls?|systems?\s+engineer|systems?\s+intern|cybersecurity|cyber\s+security|security\s+engineer|cloud\s+engineer|devops|site\s+reliability|platform\s+engineer|infrastructure\s+engineer|network\s+engineer|test\s+engineer|test\s+engineering|validation\s+engineer|quality\s+engineer|materials?\s+engineer|power\s+(?:systems?|engineer)|energy\s+engineer|mechatronics|product\s+design\s+engineer|flight\s+software|propulsion|avionics|computer\s+vision|autonomous\s+systems)\b/i;

export type MassFeedCandidate = {
  discoverySource: "simplify" | "zapply";
  sourceJobId: string;
  title: string;
  company: string;
  location: string | null;
  postedAt: Date | null;
  postedAtText: string | null;
  officialUrl: string;
};

function hashKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function visibleHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCompany(value: string): string {
  return value
    .replace(/[🔥🛂🇺🇸🔒🎓✅🏛]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTechnicalInternship(title: string): boolean {
  return TECHNICAL_ROLE_PATTERN.test(title);
}

function validDirectUrl(value: string | null): value is string {
  if (!value || isAggregatorUrl(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const path = url.pathname.toLowerCase();
    const hasStrongJobPath =
      /\/(?:job|jobs|position|positions|requisition|requisitions|opening|openings|opportunity|opportunities|vacancy|vacancies)\/[^/]+/i.test(path) ||
      /\/candidateexperience\/.*\/job\/[^/]+/i.test(path) ||
      /\/detail\/[^/]+/i.test(path) ||
      /\/position\/[^/]+\/detail/i.test(path);
    const hasJobQuery = [...url.searchParams.entries()].some(
      ([key, candidate]) =>
        /^(?:job|jobid|job_id|jid|gh_jid|req|reqid|req_id|requisition|requisitionid|career_job_req_id|positionid|postingid)$/i.test(key) &&
        candidate.trim().length > 0,
    );
    return isValidOfficialApplicationUrl(value) || hasStrongJobPath || hasJobQuery;
  } catch {
    return false;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/plain,text/markdown,*/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function hrefs(value: string): string[] {
  return [...value.matchAll(/href=["']([^"']+)["']/gi)].map((match) => decodeEntities(match[1]!));
}

export function parseSimplifyFeed(markdown: string, capturedAt = new Date()): MassFeedCandidate[] {
  const result: MassFeedCandidate[] = [];
  const rows = markdown.match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];
  let lastCompany: string | null = null;

  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1] ?? "");
    if (cells.length < 5) continue;

    const companyText = cleanCompany(visibleHtml(cells[0]!));
    if (companyText && companyText !== "↳") lastCompany = companyText;
    const company = companyText === "↳" ? lastCompany : companyText || lastCompany;
    const title = visibleHtml(cells[1]!);
    const location = visibleHtml(cells[2]!) || null;
    if (!company || !title || !isTechnicalInternship(title)) continue;

    const officialUrl = hrefs(cells[3]!).find((url) => validDirectUrl(url)) ?? null;
    if (!officialUrl) continue;

    const age = visibleHtml(cells[4]!) || null;
    const sourceDate = parseFirstSourceDate([age], capturedAt);
    result.push({
      discoverySource: "simplify",
      sourceJobId: `simplify:${hashKey(`${company}|${title}|${officialUrl}`)}`,
      title,
      company,
      location,
      postedAt: sourceDate.sourcePostedAt,
      postedAtText: sourceDate.sourcePostedText,
      officialUrl,
    });
  }
  return result;
}

function markdownCellText(value: string): string {
  return decodeEntities(
    value
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function markdownUrls(value: string): string[] {
  return [...value.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((match) => decodeEntities(match[1]!));
}

export function parseZapplyFeed(markdown: string, capturedAt = new Date()): MassFeedCandidate[] {
  const result: MassFeedCandidate[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|") || /^\|\s*-+/.test(line.trim())) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6) continue;

    const company = cleanCompany(markdownCellText(cells[0]!));
    const title = markdownCellText(cells[1]!);
    const location = markdownCellText(cells[2]!) || null;
    if (!company || !title || company.toLowerCase() === "company" || !isTechnicalInternship(title)) continue;

    const officialUrl = markdownUrls(cells[5]!).find((url) => validDirectUrl(url)) ?? null;
    if (!officialUrl) continue;

    const postedText = markdownCellText(cells[3]!) || null;
    const sourceDate = parseFirstSourceDate([postedText], capturedAt);
    result.push({
      discoverySource: "zapply",
      sourceJobId: `zapply:${hashKey(`${company}|${title}|${officialUrl}`)}`,
      title,
      company,
      location,
      postedAt: sourceDate.sourcePostedAt,
      postedAtText: sourceDate.sourcePostedText,
      officialUrl,
    });
  }
  return result;
}

function canonicalIdentity(candidate: MassFeedCandidate): string {
  return canonicalizeJobUrl(candidate.officialUrl) ?? `${candidate.company}|${candidate.title}|${candidate.location ?? ""}`;
}

export async function fetchMassTechnicalCandidates(): Promise<{
  candidates: MassFeedCandidate[];
  simplifyFetched: number;
  zapplyFetched: number;
}> {
  const capturedAt = new Date();
  const [simplifyText, zapplyText] = await Promise.all([fetchText(SIMPLIFY_FEED), fetchText(ZAPPLY_FEED)]);
  const simplify = simplifyText ? parseSimplifyFeed(simplifyText, capturedAt) : [];
  const zapply = zapplyText ? parseZapplyFeed(zapplyText, capturedAt) : [];

  const seen = new Set<string>();
  const candidates: MassFeedCandidate[] = [];
  const combined = [...simplify, ...zapply].sort((a, b) => {
    const aKnown = isValidOfficialApplicationUrl(a.officialUrl) ? 1 : 0;
    const bKnown = isValidOfficialApplicationUrl(b.officialUrl) ? 1 : 0;
    if (aKnown !== bKnown) return bKnown - aKnown;
    return (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0);
  });

  for (const candidate of combined) {
    const key = canonicalIdentity(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }

  return { candidates, simplifyFetched: simplify.length, zapplyFetched: zapply.length };
}

export async function runMassTechnicalFeedDiscovery(limit = 1500): Promise<{
  sourceFetched: number;
  simplifyFetched: number;
  zapplyFetched: number;
  alreadyActive: number;
  examined: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
}> {
  const boundedLimit = Math.max(1, Math.min(limit, 2000));
  const source = await fetchMassTechnicalCandidates();

  // Bounded, targeted existing-record lookup (database-usage repair, pass
  // #4 — same fix applied to runExpandedPublicDirectFeedDiscovery in pass
  // #3): this used to load officialApplicationUrl/sourceUrl/url for EVERY
  // active job just to build an in-memory membership set. Only the URLs the
  // current feed batch actually offers can possibly match, so this queries
  // for exactly those — scaling with candidate count (bounded to 2000), not
  // catalog size. Both raw and canonicalized forms of each candidate URL are
  // included since the stored columns aren't guaranteed to already be in
  // canonical form; a rare miss here costs a harmless idempotent re-upsert,
  // not a duplicate or lost job.
  const candidateUrlVariants = new Set<string>();
  for (const candidate of source.candidates) {
    candidateUrlVariants.add(candidate.officialUrl);
    const canonical = canonicalizeJobUrl(candidate.officialUrl);
    if (canonical) candidateUrlVariants.add(canonical);
  }
  const urlList = [...candidateUrlVariants];
  const activeRows = urlList.length > 0
    ? await prisma.job.findMany({
        where: {
          activeFeed: true,
          OR: [
            { officialApplicationUrl: { in: urlList } },
            { sourceUrl: { in: urlList } },
            { url: { in: urlList } },
          ],
        },
        select: { officialApplicationUrl: true, sourceUrl: true, url: true },
      })
    : [];
  const activeUrls = new Set(
    activeRows
      .flatMap((row) => [row.officialApplicationUrl, row.sourceUrl, row.url])
      .map(canonicalizeJobUrl)
      .filter((value): value is string => Boolean(value)),
  );
  const unseen = source.candidates.filter((candidate) => {
    const canonical = canonicalizeJobUrl(candidate.officialUrl);
    return !canonical || !activeUrls.has(canonical);
  });
  const selected = unseen.slice(0, boundedLimit);

  let cursor = 0;
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  const workers = Array.from({ length: Math.min(24, selected.length) }, async () => {
    while (cursor < selected.length) {
      const candidate = selected[cursor++]!;
      const resolved = inferResolvedSource(candidate.officialUrl);
      const job: AtsJob = {
        sourceJobId: candidate.sourceJobId,
        requisitionId: null,
        title: candidate.title,
        company: candidate.company,
        location: candidate.location,
        workplaceType: null,
        applyUrl: candidate.officialUrl,
        description: "",
        postedAt: candidate.postedAt,
        postedAtText: candidate.postedAtText,
      };
      try {
        const outcome = await upsertClassifiedAtsJob({
          job,
          source: resolved.source,
          atsType: resolved.atsType,
          atsTenant: resolved.atsTenant,
          classification: "QUALIFYING_INTERNSHIP",
          classificationReason:
            `Discovered in the current ${candidate.discoverySource} technical internship index with an original employer/ATS application URL.`,
          now: new Date(),
        });
        await promoteCanonicalDirectJob(job, resolved.source, resolved.atsTenant);
        if (outcome === "new") newCount += 1;
        else if (outcome === "updated") updatedCount += 1;
        else unchangedCount += 1;
      } catch (error) {
        console.error("[mass-technical-feed] candidate failed", {
          source: candidate.discoverySource,
          company: candidate.company,
          title: candidate.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  await Promise.all(workers);

  return {
    sourceFetched: source.candidates.length,
    simplifyFetched: source.simplifyFetched,
    zapplyFetched: source.zapplyFetched,
    alreadyActive: source.candidates.length - unseen.length,
    examined: selected.length,
    newCount,
    updatedCount,
    unchangedCount,
  };
}
