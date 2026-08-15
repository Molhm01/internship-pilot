import { afterEach, describe, expect, it } from "vitest";
import {
  LocalOnlyFeatureError,
  assertLocalRuntime,
  isCloudRuntime,
  runtimeCapabilities,
  runtimeLocation,
} from "./deployment";

/**
 * The online/local boundary.
 *
 * Everything downstream — Ollama, the Internship Agent, Typst, Playwright —
 * decides whether to attempt a loopback call based on this one answer, so an
 * environment that is misclassified does not degrade gracefully: it produces a
 * hosted server confidently telling a user that the software on their own
 * computer is broken.
 */

const SAVED = {
  runtime: process.env.INTERNSHIP_PILOT_RUNTIME,
  vercel: process.env.VERCEL,
};

afterEach(() => {
  process.env.INTERNSHIP_PILOT_RUNTIME = SAVED.runtime;
  process.env.VERCEL = SAVED.vercel;
  if (SAVED.runtime === undefined) delete process.env.INTERNSHIP_PILOT_RUNTIME;
  if (SAVED.vercel === undefined) delete process.env.VERCEL;
});

describe("runtime classification", () => {
  it("treats a plain development machine as local", () => {
    delete process.env.INTERNSHIP_PILOT_RUNTIME;
    delete process.env.VERCEL;

    expect(runtimeLocation()).toBe("local");
    expect(isCloudRuntime()).toBe(false);
  });

  it("treats Vercel as cloud without needing to be told", () => {
    delete process.env.INTERNSHIP_PILOT_RUNTIME;
    process.env.VERCEL = "1";

    expect(runtimeLocation()).toBe("cloud");
  });

  it("lets a self-hosted install that really is the user's machine say so", () => {
    process.env.VERCEL = "1";
    process.env.INTERNSHIP_PILOT_RUNTIME = "local";

    expect(runtimeLocation()).toBe("local");
  });

  it("ignores a value that is neither local nor cloud rather than guessing", () => {
    delete process.env.VERCEL;
    process.env.INTERNSHIP_PILOT_RUNTIME = "staging";

    expect(runtimeLocation()).toBe("local");
  });
});

describe("local-only capability assertions", () => {
  it("passes silently on a local runtime", () => {
    delete process.env.VERCEL;
    process.env.INTERNSHIP_PILOT_RUNTIME = "local";

    expect(() => assertLocalRuntime("ollama")).not.toThrow();
  });

  it("refuses in the cloud, and says where the feature actually runs", () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";

    try {
      assertLocalRuntime("localAgent");
      throw new Error("assertLocalRuntime should have thrown in a cloud runtime.");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalOnlyFeatureError);
      const failure = error as LocalOnlyFeatureError;
      expect(failure.code).toBe("LOCAL_RUNTIME_REQUIRED");
      expect(failure.feature).toBe("localAgent");
      // The message has to point at the extension, because that is the fix.
      expect(failure.message).toMatch(/extension/i);
    }
  });
});

describe("capabilities reported to the browser", () => {
  it("reports every local-only capability as unavailable in the cloud", () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";

    expect(runtimeCapabilities()).toEqual({
      runtime: "cloud",
      serverSideAi: false,
      serverSideLocalAgent: false,
      serverSideDocumentGeneration: false,
      serverSideBrowserAutomation: false,
      requiresExtensionBridge: true,
    });
  });

  it("reports them all available locally, and no bridge requirement", () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "local";

    expect(runtimeCapabilities()).toEqual({
      runtime: "local",
      serverSideAi: true,
      serverSideLocalAgent: true,
      serverSideDocumentGeneration: true,
      serverSideBrowserAutomation: true,
      requiresExtensionBridge: false,
    });
  });

  it("exposes no secret, URL, or credential", () => {
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";
    const serialized = JSON.stringify(runtimeCapabilities());

    expect(serialized).not.toMatch(/token|secret|key|password|:\/\//i);
  });
});
