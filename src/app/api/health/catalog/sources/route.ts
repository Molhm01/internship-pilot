import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { canonicalizeJobUrl } from "@/lib/sync/ingest";
import { fetchMassTechnicalCandidates } from "@/lib/sync/massTechnicalFeeds";
import { fetchExpandedDirectCandidates } from "@/lib/sync/publicDirectFeedsExpanded";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function countBy<T>(items: T[], key: (item: T) => string): Array<{ key: string; count: number }> {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return [...map.entries()]
    .map(([value, count]) => ({ key: value, count }))
    .sort((a, b) => b.count - a.count);
}

export async function GET() {
  const [mass, expanded, activeRows] = await Promise.all([
    fetchMassTechnicalCandidates(),
    fetchExpandedDirectCandidates(),
    prisma.job.findMany({
      where: { activeFeed: true },
      select: { officialApplicationUrl: true, sourceUrl: true, url: true },
    }),
  ]);

  const activeUrls = new Set(
    activeRows
      .flatMap((row) => [row.officialApplicationUrl, row.sourceUrl, row.url])
      .map(canonicalizeJobUrl)
      .filter((value): value is string => Boolean(value)),
  );

  const massAlreadyActive = mass.candidates.filter((candidate) => {
    const canonical = canonicalizeJobUrl(candidate.officialUrl);
    return canonical !== null && activeUrls.has(canonical);
  }).length;
  const expandedAlreadyActive = expanded.candidates.filter((candidate) => {
    const canonical = canonicalizeJobUrl(candidate.officialUrl);
    return canonical !== null && activeUrls.has(canonical);
  }).length;

  return NextResponse.json(
    {
      massTechnical: {
        sourceFetched: mass.candidates.length,
        simplifyFetched: mass.simplifyFetched,
        zapplyFetched: mass.zapplyFetched,
        alreadyActive: massAlreadyActive,
        unseen: Math.max(0, mass.candidates.length - massAlreadyActive),
        byDiscoverySource: countBy(mass.candidates, (candidate) => candidate.discoverySource),
        byResolvedSource: countBy(
          mass.candidates,
          (candidate) => inferResolvedSource(candidate.officialUrl).source,
        ),
      },
      expandedDirect: {
        sourceFetched: expanded.candidates.length,
        applyGuyFetched: expanded.applyGuyFetched,
        dreamworkFetched: expanded.dreamworkFetched,
        alreadyActive: expandedAlreadyActive,
        unseen: Math.max(0, expanded.candidates.length - expandedAlreadyActive),
      },
    },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
