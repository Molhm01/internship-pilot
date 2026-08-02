import { NextResponse } from "next/server";
import { getSchedulerHealth } from "@/lib/sync/schedulerState";

export async function GET() {
  const health = await getSchedulerHealth();
  return NextResponse.json(health);
}
