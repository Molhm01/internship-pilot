/*
 * Shared data, but not public data.
 *
 * Every handler in this file operates on the global catalogue rather than on
 * one person's rows, so there is no owner to filter by — but a signed-out
 * request still has no business here, and the proxy's cookie check is not an
 * authorization layer. The session is verified on the server, per request.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const denied = await guardSession();
  if (denied) return denied;
  const jobs = await prisma.job.findMany({
    where: { verificationStatus: "SecurityQuarantine" },
    orderBy: { updatedAt: "desc" },
  });
  const jobIds = jobs.map((j) => j.id);
  const entries = await prisma.securityQuarantineEntry.findMany({
    where: { jobId: { in: jobIds } },
    orderBy: { detectedAt: "desc" },
  });
  const entriesByJob = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!e.jobId) continue;
    entriesByJob.set(e.jobId, [...(entriesByJob.get(e.jobId) ?? []), e]);
  }
  return NextResponse.json({
    jobs: jobs.map((j) => ({ ...j, quarantineEntries: entriesByJob.get(j.id) ?? [] })),
  });
}
