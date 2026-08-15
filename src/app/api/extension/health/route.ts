import { EXTENSION_PROTOCOL_VERSION, SERVER_BUILD } from "@/lib/applications/extensionProtocol";

/**
 * The compatibility handshake, and deliberately public.
 *
 * It returns version constants and nothing else — no profile, no documents, no
 * counts, nothing derived from any account. It has to answer before a token is
 * configured, because it is how the extension discovers whether it can talk to
 * this server at all.
 */
export async function GET() {
  return Response.json(
    {
      ok: true,
      service: "Internship Pilot",
      apiVersion: 1,
      // Server/extension compatibility handshake. The extension compares its
      // own protocol version to this and reports a mismatch instead of
      // attempting a broken fill run.
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      build: SERVER_BUILD,
      mode: "FILL_TO_SUBMIT",
      submitEnabled: false,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
