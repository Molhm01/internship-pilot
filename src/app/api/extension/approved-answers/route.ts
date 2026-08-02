import { prisma } from "@/lib/db";
import {
  extensionUnauthorizedResponse,
  isExtensionRequestAuthorized,
} from "@/lib/applications/extensionAuth";

export async function GET(request: Request) {
  if (!(await isExtensionRequestAuthorized(request))) return extensionUnauthorizedResponse();
  const answers = await prisma.approvedAnswer.findMany({
    orderBy: { questionText: "asc" },
    select: { id: true, questionText: true, answer: true, updatedAt: true },
  });
  return Response.json({ answers }, { headers: { "cache-control": "no-store" } });
}
