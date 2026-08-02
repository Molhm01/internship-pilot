import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
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
