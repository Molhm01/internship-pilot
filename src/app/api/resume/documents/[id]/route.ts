import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deleteResumePdf } from "@/lib/resumeStorage";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await prisma.resumeDocument.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  await deleteResumePdf(doc.storagePath);
  await prisma.resumeDocument.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
