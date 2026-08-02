export type OllamaHealth = {
  reachable: boolean;
  modelInstalled: boolean;
  models: string[];
  model: string;
  error?: string;
};

export const OLLAMA_HEALTH_CACHE_MS = 15_000;

let cached: { value: OllamaHealth; expiresAt: number } | null = null;
let inFlight: Promise<OllamaHealth> | null = null;

function isHealth(value: unknown): value is OllamaHealth {
  if (!value || typeof value !== "object") return false;
  const health = value as Partial<OllamaHealth>;
  return typeof health.reachable === "boolean"
    && typeof health.modelInstalled === "boolean"
    && Array.isArray(health.models)
    && health.models.every((model) => typeof model === "string")
    && typeof health.model === "string";
}

export async function getCachedOllamaHealth(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<OllamaHealth> {
  const currentTime = now();
  if (cached && cached.expiresAt > currentTime) return cached.value;
  if (inFlight) return inFlight;

  const startedAt = performance.now();
  inFlight = (async () => {
    let value: OllamaHealth;
    try {
      const response = await fetcher("/api/health/ollama");
      const payload = await response.json() as unknown;
      if (!response.ok || !isHealth(payload)) throw new Error("Invalid Ollama health response");
      value = payload;
    } catch {
      value = { reachable: false, modelInstalled: false, models: [], model: "" };
    }
    cached = { value, expiresAt: now() + OLLAMA_HEALTH_CACHE_MS };
    return value;
  })().finally(() => {
    inFlight = null;
    if (process.env.NODE_ENV === "development") {
      console.info(JSON.stringify({
        event: "job-page-timing",
        operation: "ollama-health-fetch",
        durationMs: Math.round(performance.now() - startedAt),
      }));
    }
  });
  return inFlight;
}

export function resetOllamaHealthCacheForTests() {
  cached = null;
  inFlight = null;
}
