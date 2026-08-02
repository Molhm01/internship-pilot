import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const entries = await prisma.assessmentInboxEntry.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ entries });
}
