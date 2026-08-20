import { prisma } from "@/lib/db";

/**
 * Radar queue rows live in AppSetting as compact JSON because the queue was
 * added without a schema migration. Health endpoints used to load + parse every
 * queue row in Node. Once the high-recall Intern List lane produced thousands of
 * rows, a single status request could transfer ~10k JSON documents from Postgres
 * to a Vercel function just to count four states.
 *
 * These queries keep the exact storage format, but perform the counting inside
 * Postgres and return only a handful of integers. We intentionally use LIKE
 * rather than value::jsonb so one malformed legacy setting can never make the
 * health endpoint fail its JSON cast. Queue records are written with
 * JSON.stringify, so the state/source markers below are stable and whitespace-
 * free.
 */

type OldQueueCountRow = {
  pending: number | bigint;
  retry: number | bigint;
  resolved: number | bigint;
  closed: number | bigint;
  abandoned: number | bigint;
};

type SupplementalCountRow = {
  source: string | null;
  pending: number | bigint;
  retry: number | bigint;
  resolved: number | bigint;
  abandoned: number | bigint;
};

function integer(value: number | bigint | null | undefined): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function getLiveDiscoveryQueueHealthFast() {
  const [rows, cursorSetting] = await Promise.all([
    prisma.$queryRawUnsafe<OldQueueCountRow[]>(`
      SELECT
        COUNT(*) FILTER (WHERE "value" LIKE '%"state":"pending"%')::int AS pending,
        COUNT(*) FILTER (WHERE "value" LIKE '%"state":"retry"%')::int AS retry,
        COUNT(*) FILTER (WHERE "value" LIKE '%"state":"resolved"%')::int AS resolved,
        COUNT(*) FILTER (WHERE "value" LIKE '%"state":"closed"%')::int AS closed,
        COUNT(*) FILTER (WHERE "value" LIKE '%"state":"abandoned"%')::int AS abandoned
      FROM "AppSetting"
      WHERE "key" LIKE 'liveDiscovery:event:%'
    `),
    prisma.appSetting.findUnique({ where: { key: "liveDiscovery:cursor:jobright-fresh" } }),
  ]);

  const row = rows[0];
  return {
    pending: integer(row?.pending),
    retry: integer(row?.retry),
    resolved: integer(row?.resolved),
    closed: integer(row?.closed),
    abandoned: integer(row?.abandoned),
    cursor: parseJson<Record<string, unknown>>(cursorSetting?.value),
  };
}

const SUPPLEMENTAL_SOURCES = [
  "intern-list-public",
  "gmail-linkedin",
  "gmail-handshake",
  "gmail-indeed",
  "gmail-glassdoor",
  "gmail-ziprecruiter",
] as const;

export async function getSupplementalRadarHealthFast() {
  const [rows, cursorSetting] = await Promise.all([
    prisma.$queryRawUnsafe<SupplementalCountRow[]>(`
      SELECT
        CASE
          WHEN "value" LIKE '%"source":"intern-list-public"%' THEN 'intern-list-public'
          WHEN "value" LIKE '%"source":"gmail-linkedin"%' THEN 'gmail-linkedin'
          WHEN "value" LIKE '%"source":"gmail-handshake"%' THEN 'gmail-handshake'
          WHEN "value" LIKE '%"source":"gmail-indeed"%' THEN 'gmail-indeed'
          WHEN "value" LIKE '%"source":"gmail-glassdoor"%' THEN 'gmail-glassdoor'
          WHEN "value" LIKE '%"source":"gmail-ziprecruiter"%' THEN 'gmail-ziprecruiter'
          ELSE 'unknown'
        END AS source,
        COUNT(*) FILTER (WHERE "value" LIKE '%"state":"pending"%')::int AS pending,
        COUNT(*) FILTER (WHERE "value" LIKE '%"state":"retry"%')::int AS retry,
        COUNT(*) FILTER (WHERE "value" LIKE '%"state":"resolved"%')::int AS resolved,
        COUNT(*) FILTER (WHERE "value" LIKE '%"state":"abandoned"%')::int AS abandoned
      FROM "AppSetting"
      WHERE "key" LIKE 'supplementalRadar:event:%'
      GROUP BY 1
    `),
    prisma.appSetting.findUnique({ where: { key: "supplementalRadar:cursor:intern-list-public" } }),
  ]);

  const bySource: Record<string, { pending: number; retry: number; resolved: number; abandoned: number }> = {};
  let pending = 0;
  let retry = 0;
  let resolved = 0;
  let abandoned = 0;

  for (const row of rows) {
    const counts = {
      pending: integer(row.pending),
      retry: integer(row.retry),
      resolved: integer(row.resolved),
      abandoned: integer(row.abandoned),
    };
    if (row.source && row.source !== "unknown") bySource[row.source] = counts;
    pending += counts.pending;
    retry += counts.retry;
    resolved += counts.resolved;
    abandoned += counts.abandoned;
  }

  // Stable keys make the Settings UI simple even before a source has produced
  // its first signal.
  for (const source of SUPPLEMENTAL_SOURCES) {
    bySource[source] ??= { pending: 0, retry: 0, resolved: 0, abandoned: 0 };
  }

  return {
    pending,
    retry,
    resolved,
    abandoned,
    bySource,
    internListCursor: parseJson<Record<string, unknown>>(cursorSetting?.value),
  };
}
