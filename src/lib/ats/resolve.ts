// ATS board resolution.
//
// Primary strategy: inspect the employer's own careers page for an ATS link or
// redirect. This is stronger evidence than guessing a board slug and unlocks
// Workday and SmartRecruiters in addition to Greenhouse / Lever / Ashby.
//
// Fallback strategy: conservative slug probing for Greenhouse / Lever / Ashby
// only. Those probes remain useful for employers whose careers pages block
// automated fetching, but weak guesses never resolve Workday/SmartRecruiters.

import { detectAtsForCareersPage } from "@/lib/ats/detect";
import { fetchJsonSafe } from "@/lib/ats/types";

export type ResolvableAts =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workday"
  | "successfactors"
  | "icims"
  | "eightfold"
  | "phenom";
type ProbeableAts = "greenhouse" | "lever" | "ashby";

export type AtsResolution = {
  atsType: ResolvableAts;
  atsIdentifier: string;
  /** The URL that established the resolution, for audit trails. */
  boardUrl: string;
  /** Number of postings observed by a probe; -1 means careers-page evidence. */
  postingCount: number;
  /** Strongest available resolution method. */
  method: "careers-page" | "board-probe";
};

const GENERIC_SLUGS = new Set([
  "jobs",
  "job",
  "careers",
  "career",
  "www",
  "apply",
  "boards",
  "board",
  "search",
  "home",
  "about",
  "team",
  "work",
  "hiring",
  "talent",
  "people",
  "recruiting",
  "us",
  "en",
  "corp",
]);

export type SlugDerivation = "name" | "domain" | "prefix";
export type SlugCandidate = { slug: string; derivation: SlugDerivation };

export function candidateSlugsDetailed(companyName: string, website?: string | null): SlugCandidate[] {
  const out: SlugCandidate[] = [];
  const push = (s: string | null | undefined, derivation: SlugDerivation) => {
    const v = (s ?? "").trim().toLowerCase();
    if (!v || v.length < 3) return;
    if (GENERIC_SLUGS.has(v)) return;
    if (!out.some((c) => c.slug === v)) out.push({ slug: v, derivation });
  };

  const cleanedName = companyName
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|plc|gmbh|holdings|group|technologies|technology|labs)\b/g, " ")
    .replace(/&/g, " and ")
    .trim();

  const squashed = cleanedName.replace(/[^a-z0-9]+/g, "");
  const hyphenated = cleanedName.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  push(squashed, "name");
  push(hyphenated, "name");

  if (website) {
    try {
      const host = new URL(website.startsWith("http") ? website : `https://${website}`).hostname
        .replace(/^www\./, "");
      const label = host.split(".")[0];
      push(label, "domain");
      push(label.replace(/[^a-z0-9]+/g, ""), "domain");
    } catch {
      // Name-derived slugs are still usable.
    }
  }

  const firstWord = cleanedName.split(/\s+/)[0];
  if (firstWord && firstWord.length >= 5) push(firstWord, "prefix");

  return out;
}

export function candidateSlugs(companyName: string, website?: string | null): string[] {
  return candidateSlugsDetailed(companyName, website).map((c) => c.slug);
}

function nameTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 3),
  );
}

export function boardNameMatchesCompany(boardName: string, companyName: string): boolean {
  const board = nameTokens(boardName);
  const company = nameTokens(companyName);
  if (board.size === 0 || company.size === 0) return false;

  const shared = [...board].filter((t) => company.has(t));
  if (shared.length === 0) return false;

  const union = new Set([...board, ...company]);
  return shared.length / union.size >= 0.6;
}

type Probe = (slug: string, companyName: string) => Promise<{ boardUrl: string; postingCount: number } | null>;

const probeGreenhouse: Probe = async (slug, companyName) => {
  const boardUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`;
  const data = (await fetchJsonSafe(boardUrl)) as { jobs?: unknown[] } | null;
  if (!data || !Array.isArray(data.jobs)) return null;

  const meta = (await fetchJsonSafe(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
  )) as { name?: string } | null;
  if (meta?.name && !boardNameMatchesCompany(meta.name, companyName)) return null;

  return { boardUrl, postingCount: data.jobs.length };
};

const probeLever: Probe = async (slug) => {
  const boardUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const data = (await fetchJsonSafe(boardUrl)) as unknown[] | null;
  if (!Array.isArray(data)) return null;
  return { boardUrl, postingCount: data.length };
};

const probeAshby: Probe = async (slug) => {
  const boardUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
  const data = (await fetchJsonSafe(boardUrl)) as { jobs?: unknown[] } | null;
  if (!data || !Array.isArray(data.jobs)) return null;
  return { boardUrl, postingCount: data.jobs.length };
};

const PROBES: ReadonlyArray<{ atsType: ProbeableAts; probe: Probe; verifiesIdentity: boolean }> = [
  { atsType: "greenhouse", probe: probeGreenhouse, verifiesIdentity: true },
  { atsType: "lever", probe: probeLever, verifiesIdentity: false },
  { atsType: "ashby", probe: probeAshby, verifiesIdentity: false },
];

const DIRECT_TYPES = new Set<ResolvableAts>([
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workday",
  "successfactors",
  "icims",
  "eightfold",
  "phenom",
]);

export type ResolveOptions = {
  throttleMs?: number;
  only?: ResolvableAts[];
  sleep?: (ms: number) => Promise<void>;
  probeFallback?: boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve one employer to a concrete ATS tenant.
 *
 * `officialCareersUrl` should be the employer's own careers page whenever we
 * have it. Direct evidence is attempted first. Conservative board-token
 * probing remains a fallback for G/L/A only.
 */
export async function resolveAtsForCompany(
  companyName: string,
  officialCareersUrl: string | null | undefined,
  options: ResolveOptions = {},
): Promise<AtsResolution | null> {
  const allowed = options.only ? new Set(options.only) : null;

  if (officialCareersUrl) {
    const detected = await detectAtsForCareersPage(officialCareersUrl);
    if (
      detected.atsIdentifier &&
      DIRECT_TYPES.has(detected.atsType as ResolvableAts) &&
      (!allowed || allowed.has(detected.atsType as ResolvableAts))
    ) {
      return {
        atsType: detected.atsType as ResolvableAts,
        atsIdentifier: detected.atsIdentifier,
        boardUrl: officialCareersUrl,
        postingCount: -1,
        method: "careers-page",
      };
    }
  }

  if (options.probeFallback === false) return null;

  const throttleMs = options.throttleMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  const vendors = PROBES.filter((p) => !allowed || allowed.has(p.atsType));
  const slugs = candidateSlugsDetailed(companyName, officialCareersUrl);

  for (const { slug, derivation } of slugs) {
    for (const { atsType, probe, verifiesIdentity } of vendors) {
      if (derivation === "prefix" && !verifiesIdentity) continue;

      const hit = await probe(slug, companyName);
      if (hit && hit.postingCount > 0) {
        return {
          atsType,
          atsIdentifier: slug,
          boardUrl: hit.boardUrl,
          postingCount: hit.postingCount,
          method: "board-probe",
        };
      }
      if (throttleMs > 0) await sleep(throttleMs);
    }
  }
  return null;
}
