import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readStoredObject } from "@/lib/storage";
import { notFoundResponse, withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/**
 * Downloading a generated résumé or cover letter.
 *
 * This route used to take an id and return the PDF. No session, no ownership
 * check — a document id was a bearer token for somebody's résumé, which is a
 * name, an address, a phone number and an employment history. Anyone who
 * learned an id, and ids appear in logs and in links, had the file.
 *
 * Now: the row is fetched by id *and* owner, and a document belonging to
 * someone else is reported as missing. 404 rather than 403 on purpose — a 403
 * confirms the id is real, which is exactly the information an id-walking
 * attack is looking for.
 */
export const GET = withUser<Params>(async (_request, user, { params }) => {
  const { id } = await params;
  const doc = await prisma.generatedDocument.findFirst({
    where: { id, userId: user.id },
    select: { id: true, type: true, version: true, storagePath: true },
  });
  if (!doc) return notFoundResponse("Document not found");

  try {
    const bytes = await readStoredObject(doc.storagePath);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${doc.type}-v${doc.version}.pdf"`,
        // A signed-in user's private document must never sit in a shared cache.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    // The storage key is logged, never the bytes; the key is a path or a blob
    // URL and both are needed to tell a missing file from a misrouted one.
    console.error("Generated PDF could not be read.", {
      documentId: doc.id,
      storagePath: doc.storagePath,
      error,
    });
    return NextResponse.json({ error: "The generated file could not be read from storage." }, { status: 404 });
  }
});
