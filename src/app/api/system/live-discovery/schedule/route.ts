import { NextResponse } from "next/server";
import { guardSession } from "@/lib/auth/session";

export const runtime = "nodejs";

const QSTASH_API = "https://qstash.upstash.io/v2";
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

function config() {
  const token = process.env.QSTASH_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  const baseUrl = productionBaseUrl();
  return { token, cronSecret, baseUrl };
}

async function qstash(path: string, init: RequestInit = {}) {
  const { token } = config();
  if (!token) throw new Error("QSTASH_TOKEN is not configured.");
  return fetch(`${QSTASH_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
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
      { error: "Could not read the QStash live-discovery schedule.", detail: detail.slice(0, 300) },
      { status: 502 },
    );
  }
  const schedule = await response.json();
  return NextResponse.json({ configured: true, scheduled: true, schedule });
}

export async function POST() {
  const denied = await guardSession();
  if (denied) return denied;
  const { token, cronSecret, baseUrl } = config();
  if (!token || !cronSecret || !baseUrl) {
    return NextResponse.json(
      {
        error: "Live scheduling is not fully configured.",
        missing: [
          ...(!token ? ["QSTASH_TOKEN"] : []),
          ...(!cronSecret ? ["CRON_SECRET"] : []),
          ...(!baseUrl ? ["production base URL"] : []),
        ],
      },
      { status: 503 },
    );
  }

  const destination = `${baseUrl}/api/cron/live-discovery`;
  const response = await qstash(`/schedules/${encodeURIComponent(destination)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Upstash-Cron": SCHEDULE_CRON,
      "Upstash-Schedule-Id": SCHEDULE_ID,
      "Upstash-Method": "POST",
      "Upstash-Timeout": "240s",
      "Upstash-Retries": "2",
      "Upstash-Forward-Authorization": `Bearer ${cronSecret}`,
    },
    body: JSON.stringify({ source: "qstash-live-discovery" }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json(
      { error: "QStash rejected the live-discovery schedule.", detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }

  const created = await response.json();
  return NextResponse.json({
    ok: true,
    scheduleId: created.scheduleId ?? SCHEDULE_ID,
    cron: SCHEDULE_CRON,
    destination,
  });
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
      { error: "Could not delete the QStash schedule.", detail: detail.slice(0, 300) },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, scheduled: false, scheduleId: SCHEDULE_ID });
}
