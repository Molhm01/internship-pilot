import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deleteResumePdf } from "@/lib/resumeStorage";
import { notFoundResponse, withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/**
 * Deleting an uploaded résumé.
 *
 * The lookup is by id *and* owner, so a document id belonging to someone else
 * answers 404 — and, more to the point, its file is never deleted. An
 * unauthenticated version of this route was a way to destroy another person's
 * résumé with nothing but its id.
 */
export const DELETE = withUser<Params>(async (_request, user, { params }) => {
  const { id } = await params;
  const doc = await prisma.resumeDocument.findFirst({ where: { id, userId: user.id } });
  if (!doc) return notFoundResponse("Document not found");

  await deleteResumePdf(doc.storagePath);
  await prisma.resumeDocument.delete({ where: { id: doc.id } });

  return NextResponse.json({ ok: true });
});
