import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isCloudRuntime, LOCAL_ONLY_FEATURES } from "@/lib/runtime/deployment";

/**
 * Delivering a freshly generated document to the local Internship Agent.
 *
 * This is the step that makes a tailored résumé survive everything the browser
 * does afterwards. Previously the only copy travelled inside an in-page
 * `postMessage` bundle keyed to the employer URL, so a redirect through Jobright
 * — or simply closing the tab — left the extension with nothing to attach. The
 * agent server keeps the file on disk under the user's own profile directory,
 * where a page refresh, a popup close, a service-worker restart, and a browser
 * restart are all irrelevant.
 *
 * Server-to-server only, over IPv4 loopback, authenticated with the same
 * `x-agent-token` the rest of this integration uses. The token is sent in a
 * header and never placed in a URL, and no document byte is ever logged.
 */

const TOKEN_HEADER = "x-agent-token";
const DELIVERY_TIMEOUT_MS = 20_000;

export type AgentDocumentType = "resume" | "cover_letter";

export type AgentDocumentDelivery = {
  documentType: AgentDocumentType;
  /** Filename the employer will see. Preserved end to end. */
  filename: string;
  bytes: Uint8Array;
  source: "tailored" | "default";
  company?: string;
  jobTitle?: string;
  jobId?: string;
  createdAt?: string;
};

export type AgentDeliveryOutcome =
  | { delivered: true; documentId: string; documentType: AgentDocumentType; filename: string }
  | { delivered: false; documentType: AgentDocumentType; reason: string };

export function agentBaseUrl(): string {
  // Loopback from a deployed server is this container, not the user's PC.
  // Refusing here means the caller reports "use the extension" instead of
  // spending the delivery timeout on a connection that cannot succeed.
  if (isCloudRuntime()) throw new Error(LOCAL_ONLY_FEATURES.localAgent);
  const configured = process.env.INTERNSHIP_AGENT_BASE_URL?.trim() || "http://127.0.0.1:4317";
  const url = new URL(configured);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("INTERNSHIP_AGENT_BASE_URL must be a loopback http:// address.");
  }
  // The agent binds IPv4 loopback. Normalizing avoids Node resolving `localhost`
  // to ::1 first and reporting an intermittent ECONNREFUSED.
  url.hostname = "127.0.0.1";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Resolves the shared secret, preferring the agent's own token file.
 *
 * The agent generates its token on first run and writes it to
 * `local-data/agent-token.txt`. A copy pasted into this repository's `.env` is a
 * snapshot, and a snapshot goes stale the moment the agent's data directory is
 * recreated — which is exactly what had happened here: every delivery was
 * answered with 401 and recorded as a failure nobody was shown. The file is the
 * one place both processes can read the same value, so it wins, and the `.env`
 * entry remains as the fallback for setups that pin the token by environment on
 * both sides.
 */
export function resolveAgentToken(): { token: string } | { error: string } {
  const tokenPath = process.env.INTERNSHIP_AGENT_TOKEN_FILE?.trim();
  if (tokenPath) {
    try {
      const fromFile = readFileSync(tokenPath, "utf8").trim();
      if (fromFile) return { token: fromFile };
    } catch {
      // Falls through to the environment copy: an agent that has never been
      // started has no token file yet, which is not a configuration error.
    }
  }

  const fromEnv = process.env.INTERNSHIP_AGENT_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv };

  return {
    error:
      "No agent token is configured. Set INTERNSHIP_AGENT_TOKEN_FILE to the agent's local-data/agent-token.txt, or INTERNSHIP_AGENT_TOKEN to the same value.",
  };
}

/** Lowercase hex SHA-256, the digest the agent contract speaks. */
export function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Sends one document and resolves only once the agent has acknowledged it.
 *
 * A rejection here means nothing was stored, so the caller must report the
 * delivery as failed rather than telling the user their résumé is on the agent.
 */
export async function deliverDocumentToAgent(
  delivery: AgentDocumentDelivery,
  fetcher: typeof fetch = fetch,
): Promise<AgentDeliveryOutcome> {
  const failure = (reason: string): AgentDeliveryOutcome => ({
    delivered: false,
    documentType: delivery.documentType,
    reason,
  });

  if (delivery.bytes.byteLength === 0) return failure("The generated file was empty.");

  let baseUrl: string;
  try {
    baseUrl = agentBaseUrl();
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Agent configuration is invalid.");
  }

  const resolved = resolveAgentToken();
  if ("error" in resolved) return failure(resolved.error);
  const token = resolved.token;

  const body = JSON.stringify({
    documentType: delivery.documentType,
    filename: delivery.filename,
    mimeType: "application/pdf",
    source: delivery.source,
    ...(delivery.company ? { company: delivery.company } : {}),
    ...(delivery.jobTitle ? { jobTitle: delivery.jobTitle } : {}),
    ...(delivery.jobId ? { jobId: delivery.jobId } : {}),
    createdAt: delivery.createdAt ?? new Date().toISOString(),
    checksum: checksumOf(delivery.bytes),
    contentBase64: Buffer.from(delivery.bytes).toString("base64"),
  });

  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/documents/latest`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch {
    return failure(
      "The local Internship Agent did not answer. Start it, then generate the document again to send it.",
    );
  }

  // Named on its own so the fix is the message rather than a generic refusal.
  // A 401 here means the two processes hold different secrets, which no amount
  // of regenerating the document will change.
  if (response.status === 401 || response.status === 403) {
    return failure(
      "The agent rejected Internship Pilot's token. Internship Pilot and the agent server are configured with different secrets — point INTERNSHIP_AGENT_TOKEN_FILE at the agent's local-data/agent-token.txt and restart Internship Pilot.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failure(`The agent returned an unreadable response (HTTP ${response.status}).`);
  }

  const envelope = payload as {
    ok?: boolean;
    data?: { id?: string };
    error?: { message?: string };
  };
  if (!response.ok || envelope.ok !== true || typeof envelope.data?.id !== "string") {
    return failure(
      envelope.error?.message ?? `The agent refused the document (HTTP ${response.status}).`,
    );
  }

  return {
    delivered: true,
    documentId: envelope.data.id,
    documentType: delivery.documentType,
    filename: delivery.filename,
  };
}

/** The filename the employer sees. Stable, ASCII, and derived from the job. */
export function tailoredFilename(
  documentType: AgentDocumentType,
  company: string,
  jobTitle: string,
): string {
  const slug = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40) || "application";
  const label = documentType === "resume" ? "Resume" : "Cover-Letter";
  return `${label}-${slug(company)}-${slug(jobTitle)}.pdf`;
}
