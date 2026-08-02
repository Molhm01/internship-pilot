import { prisma } from "@/lib/db";
import {
  extensionUnauthorizedResponse,
  isExtensionRequestAuthorized,
} from "@/lib/applications/extensionAuth";

export async function GET(request: Request) {
  if (!(await isExtensionRequestAuthorized(request))) return extensionUnauthorizedResponse();
  const profile = await prisma.applicationProfile.findUnique({ where: { id: "default" } });
  return Response.json({ profile }, { headers: { "cache-control": "no-store" } });
}
