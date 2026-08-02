import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const bullets = await prisma.resumeBullet.findMany({ orderBy: { category: "asc" } });
  return NextResponse.json({ bullets });
}
