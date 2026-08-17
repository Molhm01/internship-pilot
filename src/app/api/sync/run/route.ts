/*
 * Shared data, but not public data.
 *
 * Sync Now checks direct employer/public-authority sources, uses Intern List
 * only as a DISCOVERY signal that must resolve to the original employer post,
 * and re-checks older active jobs so confirmed closed postings leave Discover.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoveryBatch, runUsaJobsDiscovery } from "@/lib/sync/companyDiscovery";
import { runInternListOriginalSourceDiscovery } from "@/lib/sync/discoveryResolution";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";
import { reconcileDirectOfficialFeed } from "@/lib/jobs/activeFeed";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  const denied = await guardSession();
  if (denied) return denied;

  const log = await prisma.syncLog.create({ data: { source: "employer-ats", status: "running" } });
  try {
    const cutover = await reconcileDirectOfficialFeed();
    const companies = await runCompanyDiscoveryBatch(10);
    // Keep manual runs bounded for the hosted runtime. Repeated Sync Now runs
    // naturally rotate through remaining discovery/backlog and freshness rows.
    const discovery = await runInternListOriginalSourceDiscovery(12);
    const freshness = await runFreshnessVerificationBatch(10);
    const usajobs = await runUsaJobsDiscovery();
    const queue = await runQueueBatch();

    const newJobsCount =
      companies.results.reduce((sum, company) => sum + company.newCount, 0) +
      discovery.newCount +
      usajobs.newCount;
    const updatedJobsCount =
      companies.results.reduce((sum, company) => sum + company.updatedCount, 0) +
      discovery.updatedCount +
      usajobs.updatedCount;
    const companyErrors = companies.results.filter((company) => company.status === "error").length;

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        newJobsCount,
        updatedJobsCount,
        ...(companyErrors > 0 ? { errorMessage: `${companyErrors} employer check(s) failed.` } : {}),
      },
    });

    return NextResponse.json({ cutover, companies, discovery, freshness, usajobs, queue });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message.slice(0, 500) },
    }).catch(() => undefined);
    return NextResponse.json({ error: "Employer sync failed." }, { status: 500 });
  }
}
