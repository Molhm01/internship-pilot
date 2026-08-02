import { NextResponse } from "next/server";
import { checkCompany } from "@/lib/sync/companyDiscovery";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await checkCompany(id);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Check failed" },
      { status: 400 },
    );
  }
}
