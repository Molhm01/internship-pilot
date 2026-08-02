import { NextResponse } from "next/server";
import { getNeedsReviewAudit, refreshNeedsReviewAudit } from "@/lib/review/audit";

export async function GET() { return NextResponse.json(await getNeedsReviewAudit()); }
export async function POST() { return NextResponse.json(await refreshNeedsReviewAudit()); }
