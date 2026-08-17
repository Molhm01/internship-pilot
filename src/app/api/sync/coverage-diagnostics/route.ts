import { NextResponse } from "next/server";
import { guardSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { type CompanyForListing } from "@/lib/ats";
import { fetchEngineeringInternships } from "@/lib/sync/internListAdapter";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { findOfficialBoardMatch } from "@/lib/sync/officialBoardMatch";

export const runtime = "nodejs";
export const maxDuration = 60;

function companyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|company|co|holdings|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function findCompanyConfig(
  companyName: string,
  companies: CompanyForListing[],
  exactMap: Map<string, CompanyForListing>,
): CompanyForListing | null {
  const key = companyKey(companyName);
  const exact = exactMap.get(key);
  if (exact) return exact;
  if (key.length < 5) return null;
  return (
    companies.find((company) => {
      const candidate = companyKey(company.name);
      return candidate.length >= 5 && (candidate.includes(key) || key.includes(candidate));
    }) ?? null
  );
}

function hasConfiguredSource(company: CompanyForListing): boolean {
  if (company.atsType && company.atsType !== "unknown") return true;
  return Boolean(company.careersUrl);
}

export async function GET() {
  const denied = await guardSession();
  if (denied) return denied;

  const [{ jobs }, companies] = await Promise.all([
    fetchEngineeringInternships(),
    prisma.company.findMany({
      where: { allowlisted: true, monitoringStatus: "active" },
      select: {
        name: true,
        atsType: true,
        atsIdentifier: true,
        careersUrl: true,
        lastETag: true,
        lastModified: true,
        contentHash: true,
      },
    }),
  ]);

  const registry = companies as CompanyForListing[];
  const registryMap = new Map<string, CompanyForListing>();
  for (const company of registry) {
    const key = companyKey(company.name);
    if (key && !registryMap.has(key)) registryMap.set(key, company);
  }

  const candidates = jobs.filter((job) => isTargetEngineeringRole(job.title, job.qualifications));
  const uniqueCompanies = new Set<string>();
  const missingCompanies = new Map<string, number>();
  const matchedCandidates: Array<{ title: string; location: string | null; company: CompanyForListing }> = [];
  let registryMatched = 0;
  let registryMissing = 0;
  let withConfiguredSource = 0;
  let withoutConfiguredSource = 0;

  for (const job of candidates) {
    uniqueCompanies.add(job.company);
    const company = findCompanyConfig(job.company, registry, registryMap);
    if (!company) {
      registryMissing += 1;
      missingCompanies.set(job.company, (missingCompanies.get(job.company) ?? 0) + 1);
      continue;
    }
    registryMatched += 1;
    if (hasConfiguredSource(company)) {
      withConfiguredSource += 1;
      matchedCandidates.push({ title: job.title, location: job.location, company });
    } else {
      withoutConfiguredSource += 1;
    }
  }

  // Probe only a bounded newest sample so the diagnostic stays safe on Vercel.
  const boardSample = matchedCandidates.slice(0, 12);
  let boardMatched = 0;
  let boardNoMatch = 0;
  let boardErrors = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, boardSample.length) }, async () => {
    while (cursor < boardSample.length) {
      const current = boardSample[cursor++]!;
      try {
        const match = await findOfficialBoardMatch(
          { title: current.title, location: current.location },
          current.company,
        );
        if (match) boardMatched += 1;
        else boardNoMatch += 1;
      } catch {
        boardErrors += 1;
      }
    }
  });
  await Promise.all(workers);

  const topMissingCompanies = Array.from(missingCompanies.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([company, count]) => ({ company, count }));

  const atsBreakdown = registry.reduce<Record<string, number>>((acc, company) => {
    const key = company.atsType || (company.careersUrl ? "careers-page" : "unresolved");
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json(
    {
      sourceCandidates: candidates.length,
      sourceCompanies: uniqueCompanies.size,
      registryCompanies: registry.length,
      registryMatched,
      registryMissing,
      withConfiguredSource,
      withoutConfiguredSource,
      boardSampled: boardSample.length,
      boardMatched,
      boardNoMatch,
      boardErrors,
      topMissingCompanies,
      atsBreakdown,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
