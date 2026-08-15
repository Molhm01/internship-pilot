import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { withExtensionUser } from "@/lib/applications/extensionAuth";

/**
 * The profile the local agent fills forms from.
 *
 * Answered for the user the extension's token belongs to, and for nobody else.
 * The previous version returned the singleton `ApplicationProfile` to any
 * caller holding the one installation-wide token.
 */
export const GET = withExtensionUser(async (_request, userId) => {
  const profile = await applicationProfileForUser(userId);
  return Response.json({ profile }, { headers: { "cache-control": "no-store" } });
});
