// Thin wrapper around the Gmail REST API (read-only). No googleapis SDK
// dependency — these are the only two endpoints this app ever calls.
export type FetchedEmail = {
  gmailMessageId: string;
  threadId: string;
  subject: string;
  fromAddress: string;
  snippet: string;
  bodyText: string;
  bodyHtml?: string;
  receivedAt: Date;
};

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function extractMimePart(payload: unknown, targetMime: "text/plain" | "text/html"): string {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined;
  if (!p) return "";
  if (p.mimeType === targetMime && p.body?.data) return decodeBase64Url(p.body.data);
  if (p.parts) {
    for (const part of p.parts) {
      const text = extractMimePart(part, targetMime);
      if (text) return text;
    }
  }
  return "";
}

function extractPlainTextBody(payload: unknown): string {
  const plain = extractMimePart(payload, "text/plain");
  if (plain) return plain;
  const html = extractMimePart(payload, "text/html");
  if (html) {
    return html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  }
  const p = payload as { body?: { data?: string } } | undefined;
  if (p?.body?.data) return decodeBase64Url(p.body.data);
  return "";
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export async function listRecentMessageIds(
  accessToken: string,
  afterEpochSeconds: number,
  extraQuery?: string,
): Promise<string[]> {
  const q = extraQuery ? `after:${afterEpochSeconds} ${extraQuery}` : `after:${afterEpochSeconds}`;
  // Job-alert radars can generate many messages in a short window. Twenty-five
  // was enough for application-status tracking but could silently skip alerts
  // when several providers were connected at once. Gmail supports up to 500;
  // 100 keeps the request bounded while leaving ample headroom.
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Gmail API error listing messages (status ${res.status}).`);
  const data = await res.json();
  return (data.messages ?? []).map((m: { id: string }) => m.id);
}

export async function fetchMessage(accessToken: string, messageId: string): Promise<FetchedEmail> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail API error fetching message ${messageId} (status ${res.status}).`);
  const data = await res.json();
  const headers = data.payload?.headers ?? [];
  const bodyHtml = extractMimePart(data.payload, "text/html");
  return {
    gmailMessageId: data.id,
    threadId: data.threadId,
    subject: headerValue(headers, "Subject"),
    fromAddress: headerValue(headers, "From"),
    snippet: data.snippet ?? "",
    bodyText: extractPlainTextBody(data.payload) || data.snippet || "",
    ...(bodyHtml ? { bodyHtml } : {}),
    receivedAt: new Date(Number(data.internalDate)),
  };
}