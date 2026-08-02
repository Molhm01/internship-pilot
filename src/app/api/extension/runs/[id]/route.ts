import { getExtensionRunState } from "@/lib/applications/extensionApi";
import {
  extensionUnauthorizedResponse,
  isExtensionRequestAuthorized,
} from "@/lib/applications/extensionAuth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isExtensionRequestAuthorized(request))) return extensionUnauthorizedResponse();
  const { id } = await params;
  const run = await getExtensionRunState(id);
  if (!run) {
    return Response.json(
      { error: "ApplicationRun not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json({ run }, { headers: { "cache-control": "no-store" } });
}
