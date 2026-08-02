import { NextResponse } from "next/server";
import { runDiscoverySync } from "@/lib/sync/discover";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoveryBatch, runUsaJobsDiscovery } from "@/lib/sync/companyDiscovery";

export async function POST() {
  const discovery = await runDiscoverySync();
  const companies = await runCompanyDiscoveryBatch(10);
  const usajobs = await runUsaJobsDiscovery();
  const queue = await runQueueBatch();
  return NextResponse.json({ discovery, companies, usajobs, queue });
}
