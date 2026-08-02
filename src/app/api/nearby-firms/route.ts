import { NextResponse } from "next/server";
import { buildLocalFirms } from "@/lib/localFirms";

export async function GET(req: Request) {
  const radius = Number(new URL(req.url).searchParams.get("radiusMiles")) || 50;
  return NextResponse.json(await buildLocalFirms(radius));
}
