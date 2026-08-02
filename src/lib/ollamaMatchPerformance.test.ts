import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setOllamaFetchForTests,
  getSharedOllamaClient,
  ollamaGenerateJSON,
} from "./ollama";

function ollamaResponse(content: string) {
  return new Response(JSON.stringify({
    message: { content },
    total_duration: 2_000_000_000,
    load_duration: 20_000_000,
    prompt_eval_duration: 300_000_000,
    eval_duration: 1_600_000_000,
  }), { status: 200 });
}

describe("shared Ollama matching client", () => {
  afterEach(() => __setOllamaFetchForTests(null));

  it("reuses one client and performs no per-job health/version request", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ollamaResponse('{"ok":true}'))
      .mockResolvedValueOnce(ollamaResponse('{"ok":true}')) as unknown as typeof fetch;
    __setOllamaFetchForTests(fetcher);

    expect(getSharedOllamaClient()).toBe(getSharedOllamaClient());
    await ollamaGenerateJSON("fixture one", { numCtx: 8_192, numPredict: 1_200, keepAlive: "10m" });
    await ollamaGenerateJSON("fixture two", { numCtx: 8_192, numPredict: 1_200, keepAlive: "10m" });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => url === "http://localhost:11434/api/chat")).toBe(true);
    const payload = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
    expect(payload).toMatchObject({
      keep_alive: "10m",
      think: false,
      options: { num_ctx: 8_192, num_predict: 1_200 },
    });
  });

  it("reports model timing without exposing model output in metadata", async () => {
    const fetcher = vi.fn().mockResolvedValue(ollamaResponse('{"private":"output"}')) as unknown as typeof fetch;
    __setOllamaFetchForTests(fetcher);
    const onTiming = vi.fn();
    await ollamaGenerateJSON("fixture", { onTiming });
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({
      modelLoadMs: 20,
      promptEvaluationMs: 300,
      modelGenerationMs: 1_600,
    }));
  });
});
