import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";

/** The signed-in user's approved résumé bullets, and only theirs. */
export const GET = withUser(async (_request, user) => {
  const bullets = await prisma.resumeBullet.findMany({
    where: { userId: user.id },
    orderBy: { category: "asc" },
  });
  return NextResponse.json({ bullets });
});
