import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedOllamaHealth,
  OLLAMA_HEALTH_CACHE_MS,
  resetOllamaHealthCacheForTests,
} from "./ollamaHealthClient";

const health = { reachable: true, modelInstalled: true, models: ["model"], model: "model" };

describe("Ollama health client", () => {
  beforeEach(() => resetOllamaHealthCacheForTests());

  it("throttles health checks for at least fifteen seconds", async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () => Response.json(health)) as unknown as typeof fetch;

    await getCachedOllamaHealth(fetcher, () => now);
    now += OLLAMA_HEALTH_CACHE_MS - 1;
    await getCachedOllamaHealth(fetcher, () => now);
    expect(fetcher).toHaveBeenCalledOnce();

    now += 2;
    await getCachedOllamaHealth(fetcher, () => now);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shares one active health request across concurrent mounts", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })) as unknown as typeof fetch;

    const first = getCachedOllamaHealth(fetcher);
    const second = getCachedOllamaHealth(fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    resolveResponse?.(Response.json(health));

    await expect(Promise.all([first, second])).resolves.toEqual([health, health]);
  });
});
