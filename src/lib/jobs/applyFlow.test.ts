import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const UI_FILES = [
  path.resolve(process.cwd(), "src/components/JobCard.tsx"),
  path.resolve(process.cwd(), "src/app/jobs/[id]/page.tsx"),
];

/**
 * "Apply with Application Agent" is back, but it must never bring the fragile
 * architecture back with it. The button hands a bundle to the extension over a
 * page bridge; it does not create a server-side session, mint a token, put a
 * session id in the employer URL, or call a local agent server.
 */
describe("Apply with Application Agent UI", () => {
  const source = UI_FILES.map((file) => readFileSync(file, "utf8")).join("\n");

  it("offers the agent handoff and a plain fallback", () => {
    expect(source).toContain("Apply with Application Agent");
    expect(source).toContain("applyWithApplicationAgent");
    expect(source).toContain("Open without agent");
    expect(source).toContain("Open source listing");
    expect(source).toContain("officialApplicationUrl");
    expect(source).toContain("The official employer application page has not been resolved yet.");
  });

  it("contains no ApplicationSession, legacy queue, localhost, or session-fragment call", () => {
    expect(source).not.toContain("/api/application-sessions");
    expect(source).not.toMatch(/\/api\/jobs\/[^"']*\/apply/);
    expect(source).not.toContain("127.0.0.1:4317");
    expect(source).not.toContain("localhost:4317");
    expect(source).not.toContain("internship-agent-session");
    expect(source).not.toContain("Could not prepare the application session");
  });

  it("never places document content or profile data in the employer URL", () => {
    const bridge = readFileSync(
      path.resolve(process.cwd(), "src/lib/applications/extensionBridge.ts"),
      "utf8",
    );
    const flow = readFileSync(
      path.resolve(process.cwd(), "src/lib/applications/applyWithAgent.ts"),
      "utf8",
    );
    for (const file of [bridge, flow, source]) {
      expect(file).not.toMatch(/searchParams\.set\((["'])(resume|coverLetter|profile|bundle)\1/);
      expect(file).not.toMatch(/#.*contentBase64/);
    }
    // The only thing ever appended to the employer URL is nothing at all: the
    // URL is opened exactly as it was resolved.
    expect(flow).toContain(
      'openWindow(input.officialApplicationUrl, "_blank", "noopener,noreferrer")',
    );
  });
});
