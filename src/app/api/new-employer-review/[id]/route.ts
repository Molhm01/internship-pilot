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
  if (!body || (body.action !== "approve" && body.action !== "reject")) {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
  }

  const entry = await prisma.newEmployerReview.findUnique({ where: { id } });
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (body.action === "reject") {
    const updated = await prisma.newEmployerReview.update({
      where: { id },
      data: { status: "rejected", reviewedAt: new Date() },
    });
    return NextResponse.json({ entry: updated });
  }

  // Approve: the user is confirming this employer's real official domain
  // once — this is the ONLY thing that turns an Intern-List-discovered
  // employer into an active discovery source going forward.
  const officialDomain: string | undefined = body.officialDomain?.trim();
  const careersUrl: string | undefined = body.careersUrl?.trim();
  if (!officialDomain) {
    return NextResponse.json({ error: "officialDomain is required to approve an employer." }, { status: 400 });
  }

  await prisma.company.upsert({
    where: { name: entry.employerName },
    update: { allowlisted: true, source: "intern-list-approved", website: `https://${officialDomain}`, ...(careersUrl ? { careersUrl } : {}) },
    create: {
      name: entry.employerName,
      website: `https://${officialDomain}`,
      careersUrl: careersUrl ?? null,
      atsType: "unknown",
      priority: "standard",
      source: "intern-list-approved",
      allowlisted: true,
    },
  });

  const updated = await prisma.newEmployerReview.update({
    where: { id },
    data: { status: "approved", reviewedAt: new Date(), guessedDomain: officialDomain },
  });
  return NextResponse.json({ entry: updated });
}
