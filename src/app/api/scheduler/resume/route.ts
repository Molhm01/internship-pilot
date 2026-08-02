import { NextResponse } from "next/server";
import { setSchedulerPaused } from "@/lib/sync/schedulerState";

export async function POST() {
  await setSchedulerPaused(false);
  return NextResponse.json({ paused: false });
}
