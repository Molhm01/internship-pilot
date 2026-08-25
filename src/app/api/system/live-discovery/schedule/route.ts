import { NextResponse } from "next/server";
import { guardSession } from "@/lib/auth/session";

export const runtime = "nodejs";

const DEFAULT_QSTASH_APIS = [
  "https://qstash.upstash.io/v2",
  "https://qstash-us-east-1.upstash.io/v2",
] as const;
const SCHEDULE_ID = "internship-pilot-live-discovery";
const SCHEDULE_CRON = "*/5 * * * *";

function productionBaseUrl(): string | null {
  const raw =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    null;
  if (!raw) return null;
  const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return normalized.replace(/\/$/, "");
}

function normalizeQstashApi(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v2") ? trimmed : `${trimmed}/v2`;
}

function qstashApis(): string[] {
  const configured = process.env.QSTASH_URL?.trim();
  const candidates = [
    ...(configured ? [normalizeQstashApi(configured)] : []),
    ...DEFAULT_QSTASH_APIS,
  ];
  return [...new Set(candidates)];
}

function config() {
  const token = process.env.QSTASH_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  const baseUrl = productionBaseUrl();
  return { token, cronSecret, baseUrl };
}

async function isRegionMismatch(response: Response): Promise<boolean> {
  if (response.ok) return false;
  const detail = await response.clone().text().catch(() => "");
  return /not found in this region|correct endpoint/i.test(detail);
}

/**
 * QStash tokens are regional. The global qstash.upstash.io endpoint currently
 * maps to EU, while US accounts use qstash-us-east-1.upstash.io. A token sent
 * to the wrong region returns a specific "not found in this region" response.
 *
 * Prefer an explicit QSTASH_URL when one is configured, otherwise try the
 * documented EU/default and US endpoints. We retry only on that exact regional
 * mismatch; normal 4xx/5xx responses are returned immediately so a real API
 * problem is never hidden by endpoint fallback.
 */
async function qstash(path: string, init: RequestInit = {}) {
  const { token } = config();
  if (!token) throw new Error("QSTASH_TOKEN is not configured.");

  let lastResponse: Response | null = null;
  for (const api of qstashApis()) {
    const response = await fetch(`${api}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
    lastResponse = response;
    if (!(await isRegionMismatch(response))) return response;
  }

  return lastResponse!;
}

export async function GET() {
  const denied = await guardSession();
  if (denied) return denied;
  const { token, cronSecret, baseUrl } = config();
  if (!token || !cronSecret || !baseUrl) {
    return NextResponse.json({
      configured: false,
      missing: [
        ...(!token ? ["QSTASH_TOKEN"] : []),
        ...(!cronSecret ? ["CRON_SECRET"] : []),
        ...(!baseUrl ? ["production base URL"] : []),
      ],
      scheduleId: SCHEDULE_ID,
      cron: SCHEDULE_CRON,
    });
  }

  const response = await qstash(`/schedules/${SCHEDULE_ID}`);
  if (response.status === 404) {
    return NextResponse.json({
      configured: true,
      scheduled: false,
      scheduleId: SCHEDULE_ID,
      cron: SCHEDULE_CRON,
      destination: `${baseUrl}/api/cron/live-discovery`,
    });
  }
  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json(
      { error: "Could not read the QStash live-discovery schedule.", detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }
  const schedule = await response.json();
  return NextResponse.json({ configured: true, scheduled: true, schedule });
}

/**
 * Recurring-schedule creation is permanently disabled here.
 *
 * GitHub Actions (`.github/workflows/live-job-ingestion.yml`) is the single
 * production scheduler owner. A QStash schedule pointed at
 * `/api/cron/live-discovery` used to run a full discovery cycle every five
 * minutes in parallel with GitHub Actions' own five-minute "fresh" lane —
 * two independent schedulers doing overlapping work on the same cadence,
 * which was the largest single driver of the Prisma Postgres Free-plan
 * overage (see the DATABASE USAGE DIAGNOSTIC). This endpoint must not be able
 * to recreate that duplication, so POST no longer calls QStash at all.
 *
 * If an unattended admin script or a stale bookmark still hits this route
 * expecting to (re)create the schedule, it gets a clear 410 rather than a
 * silently-accepted schedule.
 */
export async function POST() {
  const denied = await guardSession();
  if (denied) return denied;
  return NextResponse.json(
    {
      error:
        "Recurring QStash scheduling for /api/cron/live-discovery has been retired. " +
        "GitHub Actions (.github/workflows/live-job-ingestion.yml) is the sole production " +
        "scheduler. If a QStash schedule still exists from before this change, delete it with " +
        "DELETE /api/system/live-discovery/schedule (or `curl -X DELETE https://api.upstash.com/v2/schedules/" +
        SCHEDULE_ID +
        "` / the Upstash console) — see the cleanup note in the DATABASE EFFICIENCY REPAIR report.",
      scheduleId: SCHEDULE_ID,
      retired: true,
    },
    { status: 410 },
  );
}

export async function DELETE() {
  const denied = await guardSession();
  if (denied) return denied;
  const { token } = config();
  if (!token) {
    return NextResponse.json({ error: "QSTASH_TOKEN is not configured." }, { status: 503 });
  }
  const response = await qstash(`/schedules/${SCHEDULE_ID}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    const detail = await response.text();
    return NextResponse.json(
      { error: "Could not delete the QStash schedule.", detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, scheduled: false, scheduleId: SCHEDULE_ID });
}
