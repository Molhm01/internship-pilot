import { NextResponse } from "next/server";
import {
  NoStoredDocumentsError,
  deliverLatestDocumentsForJob,
} from "@/lib/documents/deliverLatest";

/**
 * "Send latest documents to extension".
 *
 * Delivery-only: it compiles nothing, writes no new version row, and touches no
 * document content. It exists so a transport failure — the agent was closed, or
 * the two sides held different tokens — can be retried against the documents
 * already on the page.
 */

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let id = "unknown";
  try {
    ({ id } = await params);
    const report = await deliverLatestDocumentsForJob(id);
    console.info(JSON.stringify({
      event: "tailored-document-redelivery",
      jobId: id,
      resume: report.resume?.delivered ?? null,
      coverLetter: report.coverLetter?.delivered ?? null,
    }));
    return NextResponse.json({ ok: true, agentDelivery: report }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof NoStoredDocumentsError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 404 });
    }
    console.error("Re-delivering tailored documents failed.", { jobId: id, error });
    return NextResponse.json(
      { ok: false, error: "The documents could not be re-sent. The stored files were left unchanged." },
      { status: 500 },
    );
  }
}
