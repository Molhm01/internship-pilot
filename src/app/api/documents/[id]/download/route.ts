import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readStoredObject } from "@/lib/storage";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await prisma.generatedDocument.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  try {
    const bytes = await readStoredObject(doc.storagePath);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${doc.type}-v${doc.version}.pdf"`,
      },
    });
  } catch (error) {
    // The storage key is logged, never the bytes; the key is a path or a blob
    // URL and both are needed to tell a missing file from a misrouted one.
    console.error("Generated PDF could not be read.", { documentId: id, storagePath: doc.storagePath, error });
    return NextResponse.json({ error: "The generated file could not be read from storage." }, { status: 404 });
  }
}
