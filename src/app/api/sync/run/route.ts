/*
 * Shared data, but not public data.
 *
 * Sync Now now means employer/public-authority sources only. Intern List is
 * retained as secondary evidence tooling, not as a canonical feed source.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoveryBatch, runUsaJobsDiscovery } from "@/lib/sync/companyDiscovery";
import { reconcileDirectOfficialFeed } from "@/lib/jobs/activeFeed";

export async function POST() {
  const denied = await guardSession();
  if (denied) return denied;

  const log = await prisma.syncLog.create({ data: { source: "employer-ats", status: "running" } });
  try {
    const cutover = await reconcileDirectOfficialFeed();
    const companies = await runCompanyDiscoveryBatch(10);
    const usajobs = await runUsaJobsDiscovery();
    const queue = await runQueueBatch();

    const newJobsCount =
      companies.results.reduce((sum, company) => sum + company.newCount, 0) + usajobs.newCount;
    const updatedJobsCount =
      companies.results.reduce((sum, company) => sum + company.updatedCount, 0) + usajobs.updatedCount;
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

    return NextResponse.json({ cutover, companies, usajobs, queue });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message.slice(0, 500) },
    }).catch(() => undefined);
    return NextResponse.json({ error: "Employer sync failed." }, { status: 500 });
  }
}
