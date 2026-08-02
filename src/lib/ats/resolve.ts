// ATS board resolution.
//
// 600 of the 636 companies in the database carry atsType "unknown" with no
// board identifier, which is why direct ATS ingestion was only ever reaching
// three employers. This module turns a company name / website into a
// concrete (atsType, boardToken) pair by probing the *official, documented,
// unauthenticated* job-board endpoints of Greenhouse, Lever, and Ashby.
//
// Compliance notes:
//   - Greenhouse boards-api, Lever postings-api, and Ashby posting-api are
//     published integration endpoints intended for programmatic use. None of
//     them is disallowed by the vendors' robots.txt, and none requires
//     credentials, so probing them is a permitted access pattern.
//   - A probe is a single cheap GET per candidate slug, throttled by the
//     caller. We stop at the first hit for a company.

import { fetchJsonSafe } from "@/lib/ats/types";

export type ResolvableAts = "greenhouse" | "lever" | "ashby";

export type AtsResolution = {
  atsType: ResolvableAts;
  atsIdentifier: string;
  /** The board URL that answered, for audit trails. */
  boardUrl: string;
  /** How many postings the board returned at resolution time. */
  postingCount: number;
};

/**
 * Candidate board slugs for a company, most likely first.
 *
 * Board tokens are almost always a squashed form of the company name or its
 * apex domain label ("Redwood Materials" -> "redwoodmaterials"), so a handful
 * of deterministic variants covers the large majority without guessing wildly.
 */
// Slugs that belong to no specific employer. These arise from careers-page
// hostnames like "jobs.abbott.com" (apex label "jobs") and match a real but
// unrelated board, so they must never be treated as a resolution.
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

// How a candidate slug was derived. "prefix" (first word of a multi-word
// name) is the weakest and is only used where the vendor lets us verify the
// board's identity — Greenhouse alone returns a board display name; Lever and
// Ashby expose no company identity in their postings API at all.
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
    // Drop corporate suffixes that never appear in a board token.
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|plc|gmbh|holdings|group|technologies|technology|labs)\b/g, " ")
    .replace(/&/g, " and ")
    .trim();

  const squashed = cleanedName.replace(/[^a-z0-9]+/g, "");
  const hyphenated = cleanedName.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  push(squashed, "name");
  push(hyphenated, "name");

  // The apex domain label is often the truest token ("fieldai.com" -> "fieldai").
  if (website) {
    try {
      const host = new URL(website.startsWith("http") ? website : `https://${website}`).hostname
        .replace(/^www\./, "");
      const label = host.split(".")[0];
      push(label, "domain");
      push(label.replace(/[^a-z0-9]+/g, ""), "domain");
    } catch {
      /* unparseable website is not an error — name-derived slugs still apply */
    }
  }

  // First word alone, for multi-word names like "Astranis Space Technologies"
  // whose board is just "astranis". Requires 5+ characters: short prefixes
  // like "air" (Air Products) collide with unrelated boards far too easily.
  const firstWord = cleanedName.split(/\s+/)[0];
  if (firstWord && firstWord.length >= 5) push(firstWord, "prefix");

  return out;
}

/** Backwards-compatible slug list. */
export function candidateSlugs(companyName: string, website?: string | null): string[] {
  return candidateSlugsDetailed(companyName, website).map((c) => c.slug);
}

/** Shared alphanumeric tokens between two names, used to confirm identity. */
function nameTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length >= 3),
  );
}

/**
 * Does a board's self-reported name plausibly belong to this company?
 *
 * Greenhouse returns the board's display name, which is the cheapest honest
 * identity check available. "Air" does not corroborate "Air Products"
 * strongly enough on its own, so we require a shared token AND that the
 * board name is not a bare truncation of the company's first word.
 */
export function boardNameMatchesCompany(boardName: string, companyName: string): boolean {
  const board = nameTokens(boardName);
  const company = nameTokens(companyName);
  if (board.size === 0 || company.size === 0) return false;

  const shared = [...board].filter((t) => company.has(t));
  if (shared.length === 0) return false;

  // Jaccard similarity: shared tokens over the union. A one-sided "coverage"
  // ratio is not enough, because a shared leading word alone clears it — the
  // Greenhouse board "General Motors" and the company "General Atomics" share
  // "general" and would both accept the same board. Penalising the tokens
  // that DIFFER is what separates them:
  //
  //   "General Motors"  vs "General Atomics"     -> 1/3  = 0.33  reject
  //   "Air"             vs "Air Products"        -> 1/2  = 0.50  reject
  //   "Redwood Materials" vs "Redwood Materials Inc" -> 2/3 = 0.67  accept
  //   "AST SpaceMobile" vs "AST SpaceMobile"     -> 2/2  = 1.00  accept
  //
  // Being wrong toward rejection is the safe direction: an unresolved company
  // is reported and can be set manually, whereas a false match silently
  // imports another employer's postings under the wrong name.
  const union = new Set([...board, ...company]);
  return shared.length / union.size >= 0.6;
}

type Probe = (slug: string, companyName: string) => Promise<{ boardUrl: string; postingCount: number } | null>;

const probeGreenhouse: Probe = async (slug, companyName) => {
  const boardUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`;
  const data = (await fetchJsonSafe(boardUrl)) as { jobs?: unknown[] } | null;
  if (!data || !Array.isArray(data.jobs)) return null;

  // Greenhouse exposes the board's display name — verify it actually belongs
  // to this employer before claiming a resolution.
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

// `verifiesIdentity` records whether the vendor lets us confirm the board
// belongs to this employer. Only Greenhouse does.
const PROBES: ReadonlyArray<{ atsType: ResolvableAts; probe: Probe; verifiesIdentity: boolean }> = [
  { atsType: "greenhouse", probe: probeGreenhouse, verifiesIdentity: true },
  { atsType: "lever", probe: probeLever, verifiesIdentity: false },
  { atsType: "ashby", probe: probeAshby, verifiesIdentity: false },
];

export type ResolveOptions = {
  /** Milliseconds to wait between probe requests. Politeness, not evasion. */
  throttleMs?: number;
  /** Restrict which ATS vendors are probed. */
  only?: ResolvableAts[];
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Probe each candidate slug against each vendor until a board answers.
 *
 * An empty board (0 postings) still counts as a resolution — the company
 * genuinely uses that ATS and may post internships later; recording it saves
 * re-probing every cycle.
 */
export async function resolveAtsForCompany(
  companyName: string,
  website: string | null | undefined,
  options: ResolveOptions = {},
): Promise<AtsResolution | null> {
  const throttleMs = options.throttleMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  const vendors = options.only ? PROBES.filter((p) => options.only!.includes(p.atsType)) : PROBES;
  const slugs = candidateSlugsDetailed(companyName, website);

  for (const { slug, derivation } of slugs) {
    for (const { atsType, probe, verifiesIdentity } of vendors) {
      // A first-word prefix is too weak to trust against a vendor that cannot
      // confirm who the board belongs to — that is how the Ashby board
      // "applied" would have been attributed to "Applied Materials".
      if (derivation === "prefix" && !verifiesIdentity) continue;

      const hit = await probe(slug, companyName);
      // A board with zero postings is not evidence of ownership — Ashby and
      // Lever answer 200 for boards we cannot attribute, so an empty result
      // is indistinguishable from a wrong guess. Require real postings.
      if (hit && hit.postingCount > 0) {
        return { atsType, atsIdentifier: slug, boardUrl: hit.boardUrl, postingCount: hit.postingCount };
      }
      if (throttleMs > 0) await sleep(throttleMs);
    }
  }
  return null;
}
