const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const GEMINI_MATCH_MODEL =
  process.env.GEMINI_MATCH_MODEL?.trim()
  || process.env.GEMINI_MODEL?.trim()
  || "gemini-4-hydrogen";

export type GeminiErrorCode =
  | "GEMINI_API_KEY_MISSING"
  | "GEMINI_TIMEOUT"
  | "GEMINI_HTTP_ERROR"
  | "GEMINI_EMPTY_RESPONSE"
  | "GEMINI_INVALID_JSON";

export class GeminiError extends Error {
  constructor(
    message: string,
    public readonly code: GeminiErrorCode,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export function hasGeminiApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: unknown }>;
    };
    finishReason?: string;
  }>;
};

function responseText(body: GeminiGenerateResponse): string {
  return (body.candidates?.[0]?.content?.parts ?? [])
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();
}

function sanitizeSchemaForGemini(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeSchemaForGemini);
  }
  if (!node || typeof node !== "object") return node;

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, rawVal] of Object.entries(obj)) {
    // Gemini v1beta responseSchema rejects JSON-Schema-only keywords like additionalProperties
    if (key === "additionalProperties" || key === "$schema") continue;

    if (key === "type" && Array.isArray(rawVal)) {
      const nonNull = rawVal.filter((item) => item !== "null");
      const primary = typeof nonNull[0] === "string" ? nonNull[0].toUpperCase() : "STRING";
      out.type = primary;
      if (rawVal.includes("null")) out.nullable = true;
      continue;
    }

    if (key === "type" && typeof rawVal === "string") {
      out.type = rawVal.toUpperCase();
      continue;
    }

    out[key] = sanitizeSchemaForGemini(rawVal);
  }

  return out;
}

/**
 * Small server-only Gemini client for deterministic scoring JSON.
 *
 * The API key is sent only in Google's x-goog-api-key request header. It is
 * never put in a URL, response, browser bundle, or log. The caller still runs
 * the result through the existing Zod + grounding checks before persistence.
 */
export async function geminiGenerateJSON<T = unknown>(
  prompt: string,
  options: {
    schema: Record<string, unknown>;
    timeoutMs?: number;
    model?: string;
  },
): Promise<T> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GeminiError(
      "GEMINI_API_KEY is not configured for this deployment.",
      "GEMINI_API_KEY_MISSING",
      503,
    );
  }

  const model = options.model?.trim() || GEMINI_MATCH_MODEL;
  const endpoint = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const sanitizedSchema = sanitizeSchemaForGemini(options.schema);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: sanitizedSchema,
          thinkingConfig: { thinkingLevel: "LOW" },
          maxOutputTokens: 2400,
        },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      cache: "no-store",
    });
  } catch (error) {
    const timedOut = error instanceof Error && /abort|timeout/i.test(error.message);
    throw new GeminiError(
      timedOut ? "Gemini scoring timed out." : "Gemini could not be reached.",
      timedOut ? "GEMINI_TIMEOUT" : "GEMINI_HTTP_ERROR",
      timedOut ? 504 : 503,
    );
  }

  const rawBody = await response.text();
  if (!response.ok) {
    // Keep provider response bodies out of logs and user-facing errors. They can
    // contain project/account metadata even though the API key itself is not
    // echoed by Google.
    throw new GeminiError(
      `Gemini scoring returned HTTP ${response.status}.`,
      "GEMINI_HTTP_ERROR",
      response.status >= 500 || response.status === 429 ? 503 : 502,
    );
  }

  let envelope: GeminiGenerateResponse;
  try {
    envelope = JSON.parse(rawBody) as GeminiGenerateResponse;
  } catch {
    throw new GeminiError(
      "Gemini returned an invalid API response.",
      "GEMINI_INVALID_JSON",
      502,
    );
  }

  const text = responseText(envelope);
  if (!text) {
    throw new GeminiError(
      "Gemini returned an empty scoring response.",
      "GEMINI_EMPTY_RESPONSE",
      502,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError(
      "Gemini returned scoring output that was not valid JSON.",
      "GEMINI_INVALID_JSON",
      502,
    );
  }
}
