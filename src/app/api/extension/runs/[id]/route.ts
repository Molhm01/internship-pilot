import { getExtensionRunState } from "@/lib/applications/extensionApi";
import { withExtensionUser } from "@/lib/applications/extensionAuth";

type Params = { params: Promise<{ id: string }> };

/**
 * The state of one application run, for the extension driving it.
 *
 * Scoped to the token's user: a run id is not a capability. A run holds the
 * questions an employer asked and the answers that were given, so reading
 * somebody else's by id would disclose their application.
 */
export const GET = withExtensionUser<Params>(async (_request, userId, { params }) => {
  const { id } = await params;
  const run = await getExtensionRunState(id, userId);
  if (!run) {
    return Response.json(
      { error: "ApplicationRun not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json({ run }, { headers: { "cache-control": "no-store" } });
});
