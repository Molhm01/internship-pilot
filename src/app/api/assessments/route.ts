import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";

/** Assessment invitations found in this user's own connected mailbox. */
export const GET = withUser(async (_request, user) => {
  const entries = await prisma.assessmentInboxEntry.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ entries });
});
