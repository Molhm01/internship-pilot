import { NextResponse } from "next/server";
import { runCompanyDiscoveryBatch } from "@/lib/sync/companyDiscovery";
import { isSchedulerPaused } from "@/lib/sync/schedulerState";

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
  const batchSize = Math.min(25, Math.max(1, Number.parseInt(process.env.CRON_JOB_BATCH_SIZE ?? "8", 10) || 8));
  const result = await runCompanyDiscoveryBatch(batchSize);

  const newJobs = result.results.reduce((sum, company) => sum + company.newCount, 0);
  const updatedJobs = result.results.reduce((sum, company) => sum + company.updatedCount, 0);
  const errors = result.results.filter((company) => company.status === "error").length;
  const unsupported = result.results.filter((company) => company.status === "unsupported").length;

  return NextResponse.json(
    {
      ok: errors === 0,
      checked: result.checked,
      newJobs,
      updatedJobs,
      errors,
      unsupported,
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
}
