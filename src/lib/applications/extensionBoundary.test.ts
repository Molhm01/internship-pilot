import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The bridge between a hosted website and the user's local Agent.
 *
 * Once Internship Pilot is deployed, the browser is the only thing that can
 * see both sides: the website over HTTPS and the Agent over loopback. The
 * extension is therefore the transport, and these tests pin the two properties
 * that make that safe — the page hands data to the extension rather than to a
 * network address, and the extension will only carry the API token to an
 * origin that cannot be read off the wire.
 */

async function repoFile(relative: string): Promise<string> {
  return readFile(path.join(process.cwd(), relative), "utf8");
}

describe("website to extension handoff", () => {
  it("moves documents in the message payload, never through a URL", async () => {
    const source = await repoFile("src/lib/applications/extensionBridge.ts");

    // Bytes travel inside postMessage, scoped to this tab's own origin.
    expect(source).toContain("target.location.origin");
    expect(source).toContain("contentBase64");
    // No address of a local server appears anywhere in the browser bundle.
    expect(source).not.toContain("4317");
    expect(source).not.toContain("127.0.0.1");
  });

  it("is the one bundle transport, not a second system alongside it", async () => {
    const source = await repoFile("src/lib/applications/extensionBridge.ts");

    expect(source).toContain("internship-agent:bundle-offer");
    expect(source).toContain("internship-agent:bundle-result");
  });
});

describe("extension backend selection", () => {
  it("accepts a hosted https origin so a deployed website is reachable", async () => {
    const source = await repoFile("extension/dist/background.js");

    expect(source).toContain("isSecureRemoteBase");
    expect(source).toContain('url.protocol === "https:"');
  });

  it("refuses plain http to anywhere but loopback, because the token travels with every request", async () => {
    const source = await repoFile("extension/dist/background.js");
    const loopbackCheck = source.slice(
      source.indexOf("function isLoopbackBase"),
      source.indexOf("function isAllowedBase"),
    );

    expect(loopbackCheck).toContain('url.protocol === "http:"');
    expect(loopbackCheck).toContain('url.hostname === "localhost"');
    expect(loopbackCheck).toContain('url.hostname === "127.0.0.1"');
    // Saving a backend goes through the combined check, never the raw input.
    expect(source).toContain("isAllowedBase(`${backendBaseUrl}/`)");
  });

  it("never contacts the local Agent itself", async () => {
    // The extension talks to the website and to the page it is filling. The
    // Agent is the local Agent's own business; a second path to it here would
    // be exactly the duplicate system this architecture avoids.
    const source = await repoFile("extension/dist/background.js");

    expect(source).not.toContain("4317");
  });

  it("loads no remote code, on any origin", async () => {
    const source = await repoFile("extension/dist/background.js");

    expect(source).not.toMatch(/importScripts\s*\(\s*["']https?:/i);
  });
});
