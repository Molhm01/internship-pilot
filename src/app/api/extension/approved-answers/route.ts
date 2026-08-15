import { prisma } from "@/lib/db";
import { withExtensionUser } from "@/lib/applications/extensionAuth";

/** The answers this user saved. Never another account's. */
export const GET = withExtensionUser(async (_request, userId) => {
  const answers = await prisma.approvedAnswer.findMany({
    where: { userId },
    orderBy: { questionText: "asc" },
    select: { id: true, questionText: true, answer: true, updatedAt: true },
  });
  return Response.json({ answers }, { headers: { "cache-control": "no-store" } });
});
