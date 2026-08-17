/*
 * Shared data, but not public data.
 *
 * Sync Now performs a broad direct-employer sweep, uses Intern List only as a
 * DISCOVERY signal that must resolve to the original employer post, and then
 * re-checks older active jobs so confirmed closed postings leave Discover.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoverySweep, runUsaJobsDiscovery } from "@/lib/sync/companyDiscovery";
import { runInternListOriginalSourceDiscovery } from "@/lib/sync/discoveryResolution";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";
import { reconcileDirectOfficialFeed } from "@/lib/jobs/activeFeed";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  const denied = await guardSession();
  if (denied) return denied;

  const log = await prisma.syncLog.create({ data: { source: "employer-ats", status: "running" } });
  try {
    const cutover = await reconcileDirectOfficialFeed();

    // Spend most of the serverless time budget on the employer registry itself.
    // Never-checked companies come first; subsequent runs resume with the
    // least-recently checked companies rather than re-checking the same few.
    const companies = await runCompanyDiscoverySweep({
      limit: 1000,
      concurrency: 10,
      maxRuntimeMs: 180_000,
    });

    const discovery = await runInternListOriginalSourceDiscovery(20);
    const freshness = await runFreshnessVerificationBatch(50);
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

    return NextResponse.json({
      cutover,
      companies,
      discovery,
      freshness,
      usajobs,
      queue,
      companySweepRemaining: Math.max(0, companies.totalEligible - companies.checked),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message.slice(0, 500) },
    }).catch(() => undefined);
    return NextResponse.json({ error: "Employer sync failed." }, { status: 500 });
  }
}
