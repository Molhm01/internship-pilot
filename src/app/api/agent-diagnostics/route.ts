import { NextResponse } from "next/server";
import { getAgentDiagnostics } from "@/lib/applications/diagnostics";
import { withUser } from "@/lib/auth/session";

/** The caller's own agent diagnostics: their profile, documents and runs. */
export const GET = withUser(async (_request, user) =>
  NextResponse.json(await getAgentDiagnostics(user.id)),
);
