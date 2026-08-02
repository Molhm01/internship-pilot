import { NextResponse } from "next/server";
import { buildLocalFirms } from "@/lib/localFirms";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  return NextResponse.json(await buildLocalFirms(Number(body?.radiusMiles) || 50));
}
