/*
 * Distinct company names among currently-active jobs, for the Jobs page
 * Company filter's autocomplete. Shared catalogue data, not per-user — same
 * auth posture as GET /api/companies.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const MAX_COMPANIES = 500;

export async function GET() {
  const denied = await guardSession();
  if (denied) return denied;

  const rows = await prisma.job.findMany({
    where: { activeFeed: true },
    distinct: ["company"],
    select: { company: true },
    orderBy: { company: "asc" },
    take: MAX_COMPANIES,
  });

  return NextResponse.json(
    { companies: rows.map((row) => row.company) },
    { headers: { "cache-control": "no-store" } },
  );
}
