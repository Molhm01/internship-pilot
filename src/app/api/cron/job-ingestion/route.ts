import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runCompanyDiscoveryBatch } from "@/lib/sync/companyDiscovery";
import { runInternListOriginalSourceDiscovery } from "@/lib/sync/discoveryResolution";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";
import { isSchedulerPaused } from "@/lib/sync/schedulerState";
import { reconcileDirectOfficialFeed } from "@/lib/jobs/activeFeed";

export const runtime = "nodejs";
export const maxDuration = 60;

function unauthorized() {
  return NextResponse.json(
    { error: "Unauthorized cron request." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  if (await isSchedulerPaused()) {
    return NextResponse.json(
      { ok: true, skipped: "scheduler_paused", checked: 0, newJobs: 0, updatedJobs: 0, errors: 0 },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const startedAt = Date.now();
  const log = await prisma.syncLog.create({ data: { source: "employer-ats", status: "running" } });

  try {
    // Keep the direct-source feed repaired first, then add new employer jobs,
    // resolve fresh aggregator discoveries to their ORIGINAL employer posting,
    // and finally re-check older visible jobs for confirmed closure.
    const cutover = await reconcileDirectOfficialFeed();

    const batchSize = Math.min(25, Math.max(1, Number.parseInt(process.env.CRON_JOB_BATCH_SIZE ?? "8", 10) || 8));
    const discoveryLimit = Math.min(20, Math.max(1, Number.parseInt(process.env.CRON_DISCOVERY_RESOLVE_LIMIT ?? "6", 10) || 6));
    const freshnessLimit = Math.min(25, Math.max(1, Number.parseInt(process.env.CRON_FRESHNESS_CHECK_LIMIT ?? "8", 10) || 8));

    const result = await runCompanyDiscoveryBatch(batchSize);
    const discovery = await runInternListOriginalSourceDiscovery(discoveryLimit);
    const freshness = await runFreshnessVerificationBatch(freshnessLimit);

    const companyNewJobs = result.results.reduce((sum, company) => sum + company.newCount, 0);
    const companyUpdatedJobs = result.results.reduce((sum, company) => sum + company.updatedCount, 0);
    const newJobs = companyNewJobs + discovery.newCount;
    const updatedJobs = companyUpdatedJobs + discovery.updatedCount;
    const errors = result.results.filter((company) => company.status === "error").length;
    const unsupported = result.results.filter((company) => company.status === "unsupported").length;

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: errors === result.checked && result.checked > 0 ? "error" : "success",
        finishedAt: new Date(),
        newJobsCount: newJobs,
        updatedJobsCount: updatedJobs,
        ...(errors === result.checked && result.checked > 0 ? { errorMessage: "All checked employers failed." } : {}),
      },
    });

    return NextResponse.json(
      {
        ok: errors === 0,
        cutover,
        checked: result.checked,
        newJobs,
        updatedJobs,
        errors,
        unsupported,
        discovery,
        freshness,
        durationMs: Date.now() - startedAt,
        companies: result.results.map((company) => ({
          name: company.name,
          status: company.status,
          newCount: company.newCount,
          updatedCount: company.updatedCount,
        })),
      },
      { status: errors === result.checked && result.checked > 0 ? 503 : 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message.slice(0, 500) },
    }).catch(() => undefined);
    return NextResponse.json(
      { ok: false, error: "Employer ingestion failed.", durationMs: Date.now() - startedAt },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
