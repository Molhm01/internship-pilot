/*
 * Shared data, but not public data.
 *
 * Every handler in this file operates on the global catalogue rather than on
 * one person's rows, so there is no owner to filter by — but a signed-out
 * request still has no business here, and the proxy's cookie check is not an
 * authorization layer. The session is verified on the server, per request.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardSession();
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const data: Record<string, unknown> = {};
  for (const field of ["industry", "website", "careersUrl", "atsType", "atsIdentifier"] as const) {
    if (typeof body[field] === "string") data[field] = body[field].trim() || null;
  }
  if (typeof body.priority === "string" && ["priority", "standard", "low"].includes(body.priority)) {
    data.priority = body.priority;
  }
  if (typeof body.monitoringStatus === "string" && ["active", "paused"].includes(body.monitoringStatus)) {
    data.monitoringStatus = body.monitoringStatus;
  }
  // Explicit user approval to activate scheduled checking for a company not
  // sourced from the CSV allowlist (e.g. one found via Nearby Firms) — the
  // strict two-source discovery boundary otherwise leaves it inactive.
  if (typeof body.allowlisted === "boolean") {
    data.allowlisted = body.allowlisted;
  }

  try {
    const company = await prisma.company.update({ where: { id }, data });
    return NextResponse.json({ company });
  } catch {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardSession();
  if (denied) return denied;
  const { id } = await params;
  try {
    await prisma.company.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }
}
