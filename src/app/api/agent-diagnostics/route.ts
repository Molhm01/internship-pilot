import { NextResponse } from "next/server";
import { getAgentDiagnostics } from "@/lib/applications/diagnostics";
export async function GET() { return NextResponse.json(await getAgentDiagnostics()); }
