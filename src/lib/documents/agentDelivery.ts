import { createHash } from "node:crypto";

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

function agentToken(): string {
  const token = process.env.INTERNSHIP_AGENT_TOKEN?.trim();
  if (!token) throw new Error("INTERNSHIP_AGENT_TOKEN is not configured.");
  return token;
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
  let token: string;
  try {
    baseUrl = agentBaseUrl();
    token = agentToken();
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Agent configuration is invalid.");
  }

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
