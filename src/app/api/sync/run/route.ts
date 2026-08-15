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
import { runDiscoverySync } from "@/lib/sync/discover";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoveryBatch, runUsaJobsDiscovery } from "@/lib/sync/companyDiscovery";

export async function POST() {
  const denied = await guardSession();
  if (denied) return denied;
  const discovery = await runDiscoverySync();
  const companies = await runCompanyDiscoveryBatch(10);
  const usajobs = await runUsaJobsDiscovery();
  const queue = await runQueueBatch();
  return NextResponse.json({ discovery, companies, usajobs, queue });
}
