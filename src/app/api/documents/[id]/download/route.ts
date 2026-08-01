import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";

function absolute(relativePath: string): string {
  return path.isAbsolute(relativePath)
    ? relativePath
    : path.join(/* turbopackIgnore: true */ process.cwd(), relativePath);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await prisma.generatedDocument.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  try {
    const bytes = await readFile(absolute(doc.storagePath));
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${doc.type}-v${doc.version}.pdf"`,
      },
    });
  } catch (error) {
    console.error("Generated PDF could not be read.", { documentId: id, storagePath: doc.storagePath, error });
    return NextResponse.json({ error: "The generated file could not be read from disk." }, { status: 404 });
  }
}
