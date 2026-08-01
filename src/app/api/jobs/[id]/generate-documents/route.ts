import { NextResponse } from "next/server";
import { DocumentGenerationError, generateDocumentsForJob } from "@/lib/documents/generate";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const includeCoverLetter = body?.includeCoverLetter !== false;

  try {
    const result = await generateDocumentsForJob(id, { includeCoverLetter });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DocumentGenerationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Tailored-document generation failed unexpectedly.", { jobId: id, error: err });
    return NextResponse.json(
      { error: "Document generation failed unexpectedly. Existing versions were kept." },
      { status: 500 },
    );
  }
}
