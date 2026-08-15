import { buildExtensionFillPlan } from "@/lib/applications/extensionApi";
import { withExtensionUser } from "@/lib/applications/extensionAuth";
import { validateFormDescriptionPayload } from "@/lib/applications/formSchema";

export const POST = withExtensionUser(async (request, userId) => {
  const body = await request.json().catch(() => null);
  const validation = validateFormDescriptionPayload(body, request.headers);
  if (!validation.success) {
    const status = validation.diagnostic.errorCode === "FORM_DESCRIPTION_VERSION_MISMATCH" ? 409 : 400;
    return Response.json(
      {
        error: validation.diagnostic.message,
        errorCode: validation.diagnostic.errorCode,
        validationPath: validation.diagnostic.validationPath,
        details: validation.diagnostic.sanitizedLog,
      },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    return Response.json(await buildExtensionFillPlan(validation.data, userId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not prepare a safe autofill plan." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
});
