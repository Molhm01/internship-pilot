import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The rule this whole deployment turns on: a hosted Internship Pilot server
 * must never assume its own localhost is the user's computer.
 *
 * Two of these tests exercise the runtime behaviour. The rest read source,
 * because the failure being prevented is architectural — someone adding a
 * seventh caller of Ollama, or a second route that posts to the Agent, would
 * not be caught by any behavioural test of the six that exist today.
 */

const SAVED_RUNTIME = process.env.INTERNSHIP_PILOT_RUNTIME;
const SAVED_OLLAMA = process.env.OLLAMA_BASE_URL;

afterEach(() => {
  vi.resetModules();
  delete process.env.INTERNSHIP_PILOT_RUNTIME;
  delete process.env.OLLAMA_BASE_URL;
  if (SAVED_RUNTIME !== undefined) process.env.INTERNSHIP_PILOT_RUNTIME = SAVED_RUNTIME;
  if (SAVED_OLLAMA !== undefined) process.env.OLLAMA_BASE_URL = SAVED_OLLAMA;
});

async function repoFile(relative: string): Promise<string> {
  return readFile(path.join(process.cwd(), relative), "utf8");
}

describe("the deployed server never calls the user's local Agent", () => {
  it("refuses to build a loopback Agent URL in a cloud runtime", async () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";
    vi.resetModules();
    const { agentBaseUrl } = await import("@/lib/documents/agentDelivery");

    expect(() => agentBaseUrl()).toThrow(/extension/i);
  });

  it("reports a delivery failure without opening a socket", async () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";
    vi.resetModules();
    const { deliverDocumentToAgent } = await import("@/lib/documents/agentDelivery");
    const fetcher = vi.fn();

    const outcome = await deliverDocumentToAgent(
      {
        documentType: "resume",
        filename: "Resume.pdf",
        bytes: new Uint8Array([37, 80, 68, 70]),
        source: "tailored",
      },
      fetcher as unknown as typeof fetch,
    );

    expect(outcome.delivered).toBe(false);
    // No request at all: a cloud server waiting out a 20-second timeout
    // against its own container is the failure mode this prevents.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("still works normally on a local install", async () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "local";
    vi.resetModules();
    const { agentBaseUrl } = await import("@/lib/documents/agentDelivery");

    expect(agentBaseUrl()).toBe("http://127.0.0.1:4317");
  });

  it("declines the application-session route before it reaches the Agent", async () => {
    const source = await repoFile("src/app/api/application-sessions/route.ts");

    expect(source).toContain("isCloudRuntime()");
    expect(source).toContain("LOCAL_AGENT_NOT_REACHABLE_FROM_SERVER");
    // The guard must run before the handler resolves an Agent address, which
    // is the first step of every request it would otherwise make.
    expect(source.indexOf("isCloudRuntime()")).toBeLessThan(
      source.indexOf("const baseUrl = agentBaseUrl();"),
    );
  });

  it("keeps every server-side Agent caller behind the boundary", async () => {
    // If this list grows, the new caller needs the same guard.
    const callers = [
      "src/lib/documents/agentDelivery.ts",
      "src/app/api/application-sessions/route.ts",
    ];
    for (const file of callers) {
      expect(await repoFile(file)).toContain("isCloudRuntime");
    }
  });
});

describe("the deployed server never assumes its localhost runs Ollama", () => {
  it("fails fast with LOCAL_AI_OFFLINE instead of connecting", async () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    vi.resetModules();
    const { ollamaGenerateJSON, isLocalAiUnreachable, LOCAL_AI_OFFLINE_CODE } =
      await import("@/lib/ollama");

    expect(isLocalAiUnreachable()).toBe(true);
    await expect(ollamaGenerateJSON("anything")).rejects.toMatchObject({
      code: LOCAL_AI_OFFLINE_CODE,
    });
  });

  it("answers the health probe truthfully without a request", async () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    vi.resetModules();
    const { checkOllamaHealth } = await import("@/lib/ollama");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const health = await checkOllamaHealth();

      expect(health.reachable).toBe(false);
      expect(health.error).toMatch(/local ai is offline/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("allows a deployment that really can reach a remote Ollama", async () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";
    process.env.OLLAMA_BASE_URL = "https://ollama.internal.example";
    vi.resetModules();
    const { isLocalAiUnreachable } = await import("@/lib/ollama");

    expect(isLocalAiUnreachable()).toBe(false);
  });

  it("does not interfere with local development", async () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "local";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    vi.resetModules();
    const { isLocalAiUnreachable } = await import("@/lib/ollama");

    expect(isLocalAiUnreachable()).toBe(false);
  });

  it("routes every server-side model call through the guarded module", async () => {
    // The guard lives in one place on purpose. A caller that talks to Ollama
    // directly would bypass it, so no other server module may name the port.
    const modelCallers = [
      "src/lib/matching.ts",
      "src/lib/documents/select.ts",
      "src/lib/documents/bulletLibrary.ts",
      "src/lib/gmail/classify.ts",
      "src/lib/applications/browserAgent.ts",
      "src/lib/applications/diagnostics.ts",
      "src/lib/resume/autoProfile.ts",
    ];
    for (const file of modelCallers) {
      const source = await repoFile(file);
      expect(source, `${file} must not build its own Ollama URL`).not.toContain("11434");
      expect(source, `${file} must use the shared Ollama module`).toContain("@/lib/ollama");
    }

    // Routes delegate inference to the modules above rather than calling the
    // model themselves. They are still held to the no-own-URL half of the rule.
    for (const file of ["src/app/api/resume/analyze/route.ts"]) {
      const source = await repoFile(file);
      expect(source, `${file} must not build its own Ollama URL`).not.toContain("11434");
    }
  });
});

describe("local-only server capabilities", () => {
  it("does not compile documents with Typst on a cloud runtime", async () => {
    const source = await repoFile("src/lib/documents/generate.ts");

    expect(source).toContain('assertLocalRuntime("typst")');
    expect(source.indexOf('assertLocalRuntime("typst")')).toBeLessThan(source.indexOf("compileTypst("));
  });

  it("does not register long-lived timers on a cloud runtime", async () => {
    // The scheduler's setInterval timers assume a process that stays alive.
    // On a frozen-between-requests function they fire unpredictably and every
    // cold start would add another set.
    const source = await repoFile("src/instrumentation.ts");

    expect(source).toContain("isCloudRuntime()");
    expect(source.indexOf("isCloudRuntime()")).toBeLessThan(source.indexOf("startScheduler"));
  });

  it("does not spawn a child process on a cloud runtime", async () => {
    const source = await repoFile("src/app/api/agent-diagnostics/safe-test/route.ts");

    expect(source).toContain("isCloudRuntime()");
    expect(source.indexOf("isCloudRuntime()")).toBeLessThan(source.indexOf("execFile("));
  });
});
