import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/db";
import { detectAtsFromText } from "@/lib/ats/detect";
import { isAggregatorUrl } from "@/lib/applications/officialDestination";
import { slugLooksLikeEmployer } from "@/lib/sync/employerBoardResolution";
import { stateCodes, locationsConflict } from "@/lib/sync/officialBoardMatch";

/**
 * Does every published official job actually belong to the employer it names?
 *
 *   npx tsx scripts/audit-match-quality.ts [--limit=N]
 *
 * Recall on its own is a number you can always improve by lowering the bar,
 * and the bar is the whole product: a wrong Apply URL under a real employer
 * sends someone to another company's application. So the recall benchmark is
 * paired with this — a check that the destination of every job in the active
 * feed is traceable to the employer whose name is on it.
 *
 * Read-only. It changes nothing; it only classifies.
 *
 *   confirmed  the apply URL is on the employer's own domain, or on a known
 *              ATS whose tenant is derivable from the employer name/domain
 *   ambiguous  a known ATS, but the tenant cannot be tied to this employer
 *              from the data alone — needs a human, and must not be assumed
 *   incorrect  an aggregator destination, or a tenant that belongs to a
 *              DIFFERENT employer in this same catalogue
 */

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function alphanumeric(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The employer's own domain, as far as the row itself can tell us. */
function employerDomains(company: string, careersUrl: string | null): string[] {
  const domains = new Set<string>();
  const fromCareers = careersUrl ? hostOf(careersUrl) : null;
  if (fromCareers) domains.add(fromCareers);
  const compact = alphanumeric(company);
  if (compact.length >= 4) domains.add(`${compact}.com`);
  return [...domains];
}

type Verdict = "confirmed" | "ambiguous" | "incorrect";

type Row = {
  jobId: string;
  company: string;
  title: string;
  location: string | null;
  applyUrl: string;
  source: string | null;
  verdict: Verdict;
  reason: string;
};

async function main() {
  const limit = Number.parseInt(process.argv.find((v) => v.startsWith("--limit="))?.slice(8) ?? "5000", 10) || 5000;

  const jobs = await prisma.job.findMany({
    where: {
      activeFeed: true,
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      officialApplicationUrl: { not: null },
    },
    select: {
      id: true, company: true, title: true, location: true,
      officialApplicationUrl: true, source: true, atsType: true, atsTenant: true,
    },
    take: limit,
  });

  // Which employers each ATS tenant is used by. A tenant serving two different
  // employers in the same catalogue is the signature of a cross-employer
  // mis-configuration, which is the failure mode worth finding.
  const tenantOwners = new Map<string, Set<string>>();
  for (const job of jobs) {
    const detected = detectAtsFromText(job.officialApplicationUrl!);
    if (detected.atsType === "unknown" || !detected.atsIdentifier) continue;
    const key = `${detected.atsType}:${detected.atsIdentifier}`;
    const owners = tenantOwners.get(key) ?? new Set<string>();
    owners.add(job.company);
    tenantOwners.set(key, owners);
  }

  const rows: Row[] = [];
  for (const job of jobs) {
    const url = job.officialApplicationUrl!;
    const host = hostOf(url);
    const detected = detectAtsFromText(url);

    let verdict: Verdict = "ambiguous";
    let reason = "";

    if (isAggregatorUrl(url)) {
      verdict = "incorrect";
      reason = "Apply URL is an aggregator destination.";
    } else if (!host) {
      verdict = "incorrect";
      reason = "Apply URL is not a parseable absolute URL.";
    } else if (employerDomains(job.company, null).some((domain) => host.endsWith(domain))) {
      verdict = "confirmed";
      reason = `Apply URL is on the employer's own domain (${host}).`;
    } else if (detected.atsType !== "unknown" && detected.atsIdentifier) {
      const key = `${detected.atsType}:${detected.atsIdentifier}`;
      const owners = tenantOwners.get(key) ?? new Set<string>();
      const distinctOwners = [...owners];
      if (slugLooksLikeEmployer(detected.atsIdentifier, job.company, null)) {
        verdict = "confirmed";
        reason = `${detected.atsType} tenant "${detected.atsIdentifier}" matches the employer name.`;
      } else if (distinctOwners.length > 1) {
        verdict = "incorrect";
        reason = `${detected.atsType} tenant "${detected.atsIdentifier}" is shared by ${distinctOwners.length} employers: ${distinctOwners.slice(0, 4).join(", ")}.`;
      } else {
        verdict = "ambiguous";
        reason = `${detected.atsType} tenant "${detected.atsIdentifier}" cannot be tied to "${job.company}" from this row alone.`;
      }
    } else {
      // An employer-hosted page on a host we cannot relate to the name. Common
      // and usually fine (brand names differ from legal names), so it is
      // reported as unproven rather than asserted wrong.
      verdict = "ambiguous";
      reason = `Apply URL host "${host}" is neither a known ATS nor derivable from "${job.company}".`;
    }

    rows.push({
      jobId: job.id,
      company: job.company,
      title: job.title,
      location: job.location,
      applyUrl: url,
      source: job.source,
      verdict,
      reason,
    });
  }

  const counts = { confirmed: 0, ambiguous: 0, incorrect: 0 } as Record<Verdict, number>;
  for (const row of rows) counts[row.verdict] += 1;

  // A second, independent check: within one employer, does any job's location
  // contradict its own title's stated site? Catches location-blind matching.
  let locationContradictions = 0;
  for (const row of rows) {
    const titleStates = stateCodes(row.title);
    if (titleStates.length > 0 && locationsConflict(row.title, row.location)) locationContradictions += 1;
  }

  console.log("Official match quality");
  console.log("=".repeat(64));
  console.log(`active official jobs audited   ${rows.length}`);
  console.log(`confirmed correct              ${counts.confirmed}`);
  console.log(`ambiguous (unproven)           ${counts.ambiguous}`);
  console.log(`KNOWN INCORRECT                ${counts.incorrect}`);
  console.log(`title/location contradictions  ${locationContradictions}`);

  if (counts.incorrect > 0) {
    console.log("\nincorrect rows");
    for (const row of rows.filter((candidate) => candidate.verdict === "incorrect").slice(0, 25)) {
      console.log(`  ${row.company} — ${row.title}`);
      console.log(`      ${row.applyUrl}`);
      console.log(`      ${row.reason}`);
    }
  }

  const ambiguousByHost = new Map<string, number>();
  for (const row of rows.filter((candidate) => candidate.verdict === "ambiguous")) {
    const host = hostOf(row.applyUrl) ?? "unknown";
    ambiguousByHost.set(host, (ambiguousByHost.get(host) ?? 0) + 1);
  }
  console.log("\ntop ambiguous hosts");
  for (const [host, count] of [...ambiguousByHost].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(count).padStart(4)}  ${host}`);
  }

  const outputPath = path.resolve(
    process.argv.find((v) => v.startsWith("--output="))?.slice(9) || "data/generated/match-quality.json",
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), counts, rows }, null, 2));
  console.log(`\ndataset  ${outputPath}`);

  if (counts.incorrect > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
