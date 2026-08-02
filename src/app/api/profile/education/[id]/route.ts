import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { educationData, resolveProfileOwner } from "@/lib/profile/service";

/** Ownership is re-checked on every write; an id from a request is not trusted. */
async function ownedEntry(userId: string | null, id: string) {
  const entry = await prisma.education.findUnique({ where: { id } });
  return entry && entry.userId === userId ? entry : null;
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await resolveProfileOwner();
  if (owner === undefined) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  if (!(await ownedEntry(owner, id))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  const entry = await prisma.education.update({ where: { id }, data: educationData(body) });
  return NextResponse.json({ entry });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await resolveProfileOwner();
  if (owner === undefined) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  if (!(await ownedEntry(owner, id))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await prisma.education.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
