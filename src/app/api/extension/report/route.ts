import {
  extensionReportSchema,
  recordExtensionReport,
} from "@/lib/applications/extensionApi";
import { withExtensionUser } from "@/lib/applications/extensionAuth";

export const POST = withExtensionUser(async (request, userId) => {
  const body = await request.json().catch(() => null);
  const parsed = extensionReportSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "The extension sent an invalid completion report.", details: parsed.error.issues },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    await recordExtensionReport(parsed.data, userId);
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not record the extension result." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
});
