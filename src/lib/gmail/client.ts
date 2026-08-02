// Thin wrapper around the Gmail REST API (read-only). No googleapis SDK
// dependency — these are the only two endpoints this app ever calls.
export type FetchedEmail = {
  gmailMessageId: string;
  threadId: string;
  subject: string;
  fromAddress: string;
  snippet: string;
  bodyText: string;
  receivedAt: Date;
};

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function extractPlainTextBody(payload: unknown): string {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined;
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return decodeBase64Url(p.body.data);
  if (p.parts) {
    for (const part of p.parts) {
      const text = extractPlainTextBody(part);
      if (text) return text;
    }
  }
  if (p.body?.data) return decodeBase64Url(p.body.data);
  return "";
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export async function listRecentMessageIds(accessToken: string, afterEpochSeconds: number): Promise<string[]> {
  const q = `after:${afterEpochSeconds}`;
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${encodeURIComponent(q)}`,
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
  return {
    gmailMessageId: data.id,
    threadId: data.threadId,
    subject: headerValue(headers, "Subject"),
    fromAddress: headerValue(headers, "From"),
    snippet: data.snippet ?? "",
    bodyText: extractPlainTextBody(data.payload) || data.snippet || "",
    receivedAt: new Date(Number(data.internalDate)),
  };
}
