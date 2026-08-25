import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Keep database-dependent imports inside the handler. If a deployment is
  // missing/has an invalid DATABASE_URL, a top-level import can fail before
  // GET() exists and Vercel can only return an opaque framework 500.
  if (!process.env.DATABASE_URL?.trim()) {
    return NextResponse.json(
      {
        ok: false,
        error: "Catalog database is not configured.",
        code: "DATABASE_NOT_CONFIGURED",
      },
      { status: 503, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }

  try {
    const { getCachedCatalogHealth } = await import("@/lib/sync/liveDiscoveryHealthCache");
    // Ops-monitoring callers (e.g. the hourly GH Actions catalog audit) may
    // pass ?fresh=1 to force a live computation instead of the shared cache —
    // useful when actively diagnosing a suspected regression, not for routine
    // polling.
    const force = new URL(request.url).searchParams.get("fresh") === "1";
    const { health, computedAt, fresh } = await getCachedCatalogHealth({ force });

    return NextResponse.json(
      {
        ok: true,
        activeTarget: health.activeTarget,
        active: health.active,
        targetReached: health.targetReached,
        verifiedActive: health.verifiedActive,
        total: health.total,
        freshness: {
          postedWithin24h: health.fresh24h,
          postedWithin72h: health.fresh72h,
          olderThan14Days: health.olderThan14d,
        },
        liveDiscovery: health.liveDiscovery,
        lastSuccessfulSyncAt: health.lastSuccessfulEmployerAtsSyncAt,
        lastSyncNewJobs: health.lastSuccessfulEmployerAtsSyncNewJobs,
        lastSyncUpdatedJobs: health.lastSuccessfulEmployerAtsSyncUpdatedJobs,
        activeBySource: health.activeBySource,
        computedAt,
        cacheFresh: fresh,
      },
      { headers: { "cache-control": "no-store, max-age=0" } },
    );
  } catch (error) {
    const providerCode = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "NONE")
      : "NONE";
    console.error("[health/catalog] catalog health failed", {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: providerCode,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "Catalog health is temporarily unavailable.",
        code: "CATALOG_HEALTH_FAILED",
        providerCode: providerCode === "NONE" ? undefined : providerCode,
      },
      { status: 503, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }
}
