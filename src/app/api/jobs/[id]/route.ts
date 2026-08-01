import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { TRACKER_STATUSES } from "@/lib/statuses";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await prisma.job.findUnique({
    where: { id },
    include: { matchResults: { orderBy: { createdAt: "desc" } } },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const data: Record<string, unknown> = {};
  for (const field of ["title", "company", "location", "internshipTerm", "duration", "url", "description"] as const) {
    if (typeof body[field] === "string") data[field] = body[field].trim() || null;
  }
  if (body.postingDate !== undefined) {
    data.postingDate = body.postingDate ? new Date(body.postingDate) : null;
  }
  if (typeof body.status === "string") {
    if (!TRACKER_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
    }
    data.status = body.status;
  }

  try {
    const job = await prisma.job.update({ where: { id }, data });
    return NextResponse.json({ job });
  } catch {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.job.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
}
