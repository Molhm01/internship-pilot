import "dotenv/config";

import { detectAtsFromText, detectClientRenderedAts } from "@/lib/ats/detect";

/**
 * What platform does this employer's careers site actually run on?
 *
 *   npx tsx scripts/probe-employer-platform.ts <url> [<url> …]
 *
 * A single bounded HTTP read per URL that prints every signature the page
 * carries: the vendors this codebase can already read, the vendors it cannot
 * yet, and the shape of any embedded job data. It exists so an employer is
 * configured from evidence on the employer's own site rather than from a
 * guessed tenant slug.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SIGNATURES: { name: string; regex: RegExp }[] = [
  { name: "oracle-recruiting-cloud", regex: /\/hcmUI\/CandidateExperience|\.oraclecloud\.com/i },
  { name: "taleo", regex: /taleo\.net/i },
  { name: "avature", regex: /\.avature\.net/i },
  { name: "jobvite", regex: /jobvite\.com/i },
  { name: "workable", regex: /apply\.workable\.com|workable\.com\/api/i },
  { name: "recruitee", regex: /\.recruitee\.com/i },
  { name: "dayforce", regex: /dayforcehcm\.com/i },
  { name: "brassring", regex: /brassring\.com/i },
  { name: "paylocity", regex: /recruiting\.paylocity\.com/i },
  { name: "paycom", regex: /paycomonline\.net/i },
  { name: "ultipro", regex: /ultipro\.com/i },
  { name: "adp", regex: /workforcenow\.adp\.com/i },
  { name: "teamtailor", regex: /\.teamtailor\.com/i },
  { name: "eightfold", regex: /app\.eightfold\.ai|_EF_GROUP_ID|static\.vscdn\.net/i },
  { name: "phenom", regex: /phenompeople\.com/i },
  { name: "json-ld-jobposting", regex: /"@type"\s*:\s*"JobPosting"/i },
  { name: "__NEXT_DATA__", regex: /id="__NEXT_DATA__"/i },
  { name: "graphql", regex: /\/graphql/i },
  { name: "algolia", regex: /algolia(net|\.com)/i },
];

/** URL-shaped hints worth reporting verbatim — these usually ARE the API. */
const API_HINTS = [
  /https?:\/\/[^"'\s<>]*\/(?:api|services|rest)\/[^"'\s<>]*(?:job|search|position|opening|requisition)[^"'\s<>]*/gi,
  /https?:\/\/[^"'\s<>]*(?:job|career)[^"'\s<>]*\/(?:api|search)[^"'\s<>]*/gi,
];

async function probe(url: string): Promise<void> {
  console.log(`\n=== ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, accept: "text/html,application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.log(`  FETCH FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const finalUrl = res.url || url;
  console.log(`  status      ${res.status}`);
  if (finalUrl !== url) console.log(`  redirected  ${finalUrl}`);
  console.log(`  type        ${res.headers.get("content-type") ?? "unknown"}`);

  const body = await res.text().catch(() => "");
  console.log(`  bytes       ${body.length}`);

  const supported = detectAtsFromText(`${finalUrl}\n${body}`);
  const client = detectClientRenderedAts(body, finalUrl);
  const known = supported.atsType !== "unknown" ? supported : client;
  console.log(`  SUPPORTED   ${known.atsType}${known.atsIdentifier ? ` / ${known.atsIdentifier}` : ""}`);

  const hits = SIGNATURES.filter((signature) => signature.regex.test(`${finalUrl}\n${body}`)).map((s) => s.name);
  console.log(`  signatures  ${hits.length ? hits.join(", ") : "none"}`);

  const hints = new Set<string>();
  for (const pattern of API_HINTS) {
    for (const match of body.matchAll(pattern)) hints.add(match[0].slice(0, 160));
  }
  if (hints.size) {
    console.log(`  api hints`);
    for (const hint of [...hints].slice(0, 8)) console.log(`    ${hint}`);
  }

  // Anything that looks like a posting link, which is what the employer-page
  // adapter would have to work from.
  const jobLinks = new Set<string>();
  for (const match of body.matchAll(/href="([^"]*\/(?:job|jobs|careers|opening|position)[^"]*)"/gi)) {
    jobLinks.add(match[1]!.slice(0, 120));
  }
  console.log(`  job-ish links ${jobLinks.size}`);
  for (const link of [...jobLinks].slice(0, 5)) console.log(`    ${link}`);
}

async function main() {
  const urls = process.argv.slice(2).filter((value) => value.startsWith("http"));
  if (urls.length === 0) {
    console.error("usage: probe-employer-platform.ts <url> [<url> …]");
    process.exitCode = 1;
    return;
  }
  for (const url of urls) await probe(url);
}

void main();
