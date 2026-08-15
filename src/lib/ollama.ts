import { isCloudRuntime, LOCAL_ONLY_FEATURES } from "@/lib/runtime/deployment";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/**
 * Ollama runs on the user's own computer. `localhost:11434` therefore means
 * "the user's machine" only while the web server is that machine.
 *
 * Deployed, the same URL points at the serverless container the request
 * happens to have landed in — where nothing is listening. Every AI feature
 * would fail with a connection error that reads like Ollama crashed, and the
 * honest answer (local AI cannot be reached from a website) would never be
 * shown. So the boundary is checked here, once, at the only place that talks
 * to Ollama, rather than at each of the seven callers.
 *
 * A self-hosted deployment that genuinely can reach an Ollama server sets
 * OLLAMA_BASE_URL to a non-loopback address, and is allowed through.
 */
export const LOCAL_AI_OFFLINE_CODE = "LOCAL_AI_OFFLINE";

function isLoopbackUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

/** True when this process cannot reach the user's Ollama, and knows it. */
export function isLocalAiUnreachable(): boolean {
  return isCloudRuntime() && isLoopbackUrl(OLLAMA_BASE_URL);
}

function assertLocalAiReachable(): void {
  if (isLocalAiUnreachable()) {
    throw new OllamaError(LOCAL_ONLY_FEATURES.ollama, undefined, LOCAL_AI_OFFLINE_CODE);
  }
}
export const OLLAMA_CHAT_ENDPOINT = `${OLLAMA_BASE_URL}/api/chat`;
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
export const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? OLLAMA_MODEL;

export type OllamaImageMetadata = {
  width: number;
  height: number;
  byteSize: number;
  format: "jpeg";
  quality: number;
};

export type OllamaRequestMetadata = {
  ollamaVersion: string | null;
  model: string;
  endpoint: string;
  httpStatus: number | null;
  responseBody: string;
  screenshot: OllamaImageMetadata | null;
  structuredOutputEnabled: boolean;
  structuredOutputFormat: "none" | "json" | "json_schema";
  imageBase64Logged: false;
};

export class OllamaError extends Error {
  constructor(
    message: string,
    public readonly metadata?: OllamaRequestMetadata,
    public readonly code = "OLLAMA_REQUEST_FAILED",
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

export type OllamaHealth = {
  reachable: boolean;
  modelInstalled: boolean;
  models: string[];
  error?: string;
};

type NativeChatOptions = {
  model: string;
  prompt: string;
  imageBase64?: string;
  imageMetadata?: OllamaImageMetadata;
  format?: "json" | Record<string, unknown>;
  timeoutMs?: number;
  temperature?: number;
  think?: boolean | "low" | "medium" | "high";
  keepAlive?: string;
  numPredict?: number;
  numCtx?: number;
};

export type OllamaTiming = {
  connectionMs: number;
  modelLoadMs: number;
  promptEvaluationMs: number;
  modelGenerationMs: number;
  totalModelMs: number;
  jsonParseMs: number;
};

export type OllamaChatResult = {
  content: string;
  responseBody: string;
  metadata: OllamaRequestMetadata;
  timing: Omit<OllamaTiming, "jsonParseMs">;
};

let cachedVersion: { value: string | null; expiresAt: number } | null = null;
let ollamaFetch: typeof fetch = (...args) => fetch(...args);

export function stripImageDataUrlPrefix(value: string): string {
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").trim();
}

export async function getOllamaVersion(): Promise<string | null> {
  if (isLocalAiUnreachable()) return null;
  if (cachedVersion && cachedVersion.expiresAt > Date.now()) return cachedVersion.value;
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/version`, { signal: AbortSignal.timeout(5_000) });
    const body = await response.text();
    if (!response.ok) return null;
    const parsed = JSON.parse(body) as { version?: unknown };
    const value = typeof parsed.version === "string" ? parsed.version : null;
    cachedVersion = { value, expiresAt: Date.now() + 60_000 };
    return value;
  } catch {
    return null;
  }
}

function structuredFormat(format: NativeChatOptions["format"]): OllamaRequestMetadata["structuredOutputFormat"] {
  if (format === undefined) return "none";
  return format === "json" ? "json" : "json_schema";
}

/**
 * Native Ollama chat request. Images are raw base64 strings under
 * messages[0].images. This deliberately never creates OpenAI image_url
 * objects and never records the base64 payload in logs or errors.
 */
async function performOllamaNativeChat(options: NativeChatOptions): Promise<OllamaChatResult> {
  assertLocalAiReachable();
  // Version/health checks are intentionally absent from this hot path. The
  // UI health cache owns those probes; inference uses the shared client and
  // whatever version metadata is already cached.
  const version = cachedVersion?.value ?? null;
  const image = options.imageBase64 ? stripImageDataUrlPrefix(options.imageBase64) : null;
  const payload: Record<string, unknown> = {
    model: options.model,
    messages: [{
      role: "user",
      content: options.prompt,
      ...(image ? { images: [image] } : {}),
    }],
    stream: false,
    // qwen3.5 enables thinking by default. Structured extraction and form
    // analysis need the final content, not an unbounded reasoning trace that
    // can consume the entire response budget and leave message.content empty.
    think: options.think ?? false,
    keep_alive: options.keepAlive ?? "10m",
  };
  if (options.format !== undefined) payload.format = options.format;
  payload.options = {
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.numPredict !== undefined ? { num_predict: options.numPredict } : {}),
    ...(options.numCtx !== undefined ? { num_ctx: options.numCtx } : {}),
  };

  let response: Response;
  const requestStartedAt = performance.now();
  try {
    response = await ollamaFetch(OLLAMA_CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
  } catch (error) {
    const metadata: OllamaRequestMetadata = {
      ollamaVersion: version,
      model: options.model,
      endpoint: OLLAMA_CHAT_ENDPOINT,
      httpStatus: null,
      responseBody: error instanceof Error ? error.message : String(error),
      screenshot: options.imageMetadata ?? null,
      structuredOutputEnabled: options.format !== undefined,
      structuredOutputFormat: structuredFormat(options.format),
      imageBase64Logged: false,
    };
    console.error(JSON.stringify({ event: "ollama-request-failed", ...metadata }));
    throw new OllamaError(`Could not reach Ollama at ${OLLAMA_CHAT_ENDPOINT}.`, metadata);
  }

  const responseBody = await response.text();
  const metadata: OllamaRequestMetadata = {
    ollamaVersion: version,
    model: options.model,
    endpoint: OLLAMA_CHAT_ENDPOINT,
    httpStatus: response.status,
    responseBody: response.ok ? "" : `Ollama returned HTTP ${response.status}.`,
    screenshot: options.imageMetadata ?? null,
    structuredOutputEnabled: options.format !== undefined,
    structuredOutputFormat: structuredFormat(options.format),
    imageBase64Logged: false,
  };
  if (!response.ok) {
    console.error(JSON.stringify({ event: "ollama-http-error", ...metadata }));
    throw new OllamaError(`Ollama request failed with HTTP ${response.status}.`, metadata);
  }

  let data: {
    message?: { content?: unknown };
    total_duration?: number;
    load_duration?: number;
    prompt_eval_duration?: number;
    eval_duration?: number;
  };
  try {
    data = JSON.parse(responseBody) as { message?: { content?: unknown } };
  } catch (error) {
    throw new OllamaError(
      `Ollama returned HTTP ${response.status}, but its response body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      metadata,
    );
  }
  const content = typeof data.message?.content === "string" ? data.message.content : "";
  if (!content.trim()) throw new OllamaError(`Ollama returned HTTP ${response.status} with empty message content.`, metadata);
  const nanosecondsToMs = (value: number | undefined) => Math.max(0, Math.round((value ?? 0) / 1_000_000));
  const totalObservedMs = Math.round(performance.now() - requestStartedAt);
  const totalModelMs = nanosecondsToMs(data.total_duration);
  return {
    content,
    responseBody,
    metadata,
    timing: {
      connectionMs: Math.max(0, totalObservedMs - totalModelMs),
      modelLoadMs: nanosecondsToMs(data.load_duration),
      promptEvaluationMs: nanosecondsToMs(data.prompt_eval_duration),
      modelGenerationMs: nanosecondsToMs(data.eval_duration),
      totalModelMs: totalModelMs || totalObservedMs,
    },
  };
}

export class OllamaClient {
  chat(options: NativeChatOptions): Promise<OllamaChatResult> {
    return performOllamaNativeChat(options);
  }
}

const sharedOllamaClient = new OllamaClient();

export function getSharedOllamaClient(): OllamaClient {
  return sharedOllamaClient;
}

export function ollamaNativeChat(options: NativeChatOptions): Promise<OllamaChatResult> {
  return sharedOllamaClient.chat(options);
}

export async function checkOllamaVisionHealth(): Promise<OllamaHealth> {
  if (isLocalAiUnreachable()) {
    return { reachable: false, modelInstalled: false, models: [], error: LOCAL_ONLY_FEATURES.ollama };
  }
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => "");
      return { reachable: false, modelInstalled: false, models: [], error: `Ollama responded with status ${res.status}: ${responseBody}` };
    }
    const data = await res.json() as { models?: Array<{ name: string; capabilities?: string[] }> };
    const models = (data.models ?? []).map((model) => model.name);
    const wanted = OLLAMA_VISION_MODEL.split(":")[0];
    const selected = (data.models ?? []).find((model) => model.name === OLLAMA_VISION_MODEL || model.name.split(":")[0] === wanted);
    const modelInstalled = Boolean(selected?.capabilities?.includes("vision"));
    return {
      reachable: true,
      modelInstalled,
      models,
      error: modelInstalled ? undefined : `${OLLAMA_VISION_MODEL} is missing or does not report the vision capability.`,
    };
  } catch (error) {
    return { reachable: false, modelInstalled: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function ollamaVisionRequest(
  prompt: string,
  imageBase64: string,
  imageMetadata?: OllamaImageMetadata,
  timeoutMs = 120_000,
): Promise<OllamaChatResult> {
  // Production uses Ollama's broad JSON mode and validates locally with Zod.
  // This works even when a model/Ollama build rejects a JSON Schema in format.
  return ollamaNativeChat({
    model: OLLAMA_VISION_MODEL,
    prompt,
    imageBase64,
    imageMetadata,
    format: "json",
    timeoutMs,
    temperature: 0,
  });
}

export async function ollamaVisionText(
  prompt: string,
  imageBase64: string,
  timeoutMs = 120_000,
): Promise<string> {
  return (await ollamaVisionRequest(prompt, imageBase64, undefined, timeoutMs)).content;
}

export async function ollamaVisionJSON<T>(prompt: string, imageBase64: string, timeoutMs = 120_000): Promise<T> {
  return JSON.parse(extractJson(await ollamaVisionText(prompt, imageBase64, timeoutMs))) as T;
}

export async function checkOllamaHealth(): Promise<OllamaHealth> {
  if (isLocalAiUnreachable()) {
    return { reachable: false, modelInstalled: false, models: [], error: LOCAL_ONLY_FEATURES.ollama };
  }
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => "");
      return { reachable: false, modelInstalled: false, models: [], error: `Ollama responded with status ${res.status}: ${responseBody}` };
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((model) => model.name);
    const modelInstalled = models.some(
      (name) => name === OLLAMA_MODEL || name.split(":")[0] === OLLAMA_MODEL.split(":")[0],
    );
    return { reachable: true, modelInstalled, models };
  } catch (error) {
    return { reachable: false, modelInstalled: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// Strips markdown code fences some models wrap JSON in, despite format:"json".
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

export async function ollamaGenerateJSON<T = unknown>(
  prompt: string,
  opts: {
    timeoutMs?: number;
    temperature?: number;
    format?: "json" | Record<string, unknown>;
    keepAlive?: string;
    numPredict?: number;
    numCtx?: number;
    onTiming?: (timing: OllamaTiming) => void;
  } = {},
): Promise<T> {
  const result = await ollamaNativeChat({
    model: OLLAMA_MODEL,
    prompt,
    format: opts.format ?? "json",
    timeoutMs: opts.timeoutMs,
    temperature: opts.temperature ?? 0.1,
    keepAlive: opts.keepAlive,
    numPredict: opts.numPredict,
    numCtx: opts.numCtx,
  });
  const jsonText = extractJson(result.content);
  const parseStartedAt = performance.now();
  try {
    const parsed = JSON.parse(jsonText) as T;
    opts.onTiming?.({
      ...result.timing,
      jsonParseMs: Math.round(performance.now() - parseStartedAt),
    });
    return parsed;
  } catch {
    throw new OllamaError(
      "The model did not return valid JSON.",
      result.metadata,
      "MODEL_OUTPUT_INVALID_JSON",
    );
  }
}

export function __setOllamaFetchForTests(fetcher: typeof fetch | null) {
  ollamaFetch = fetcher ?? ((...args) => fetch(...args));
}
