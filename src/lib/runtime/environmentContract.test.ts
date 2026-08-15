import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The environment contract.
 *
 * `.env.example` and DEPLOYMENT_ENVIRONMENT.md are how someone configures a
 * deployment, so a variable the code reads but the template never mentions is
 * a setup step nobody knows to perform — and a secret that leaks into the
 * client bundle is worse than a missing one. Both are checked here rather than
 * trusted to review.
 */

async function repoFile(relative: string): Promise<string> {
  return readFile(path.join(process.cwd(), relative), "utf8");
}

/** Variables the application actually depends on, by classification. */
const VERCEL_PRODUCTION = [
  "DATABASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "BLOB_READ_WRITE_TOKEN",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
];

const LOCAL_AGENT_ONLY = [
  "INTERNSHIP_AGENT_BASE_URL",
  "INTERNSHIP_AGENT_TOKEN",
  "INTERNSHIP_AGENT_TOKEN_FILE",
];

const LOCAL_DEVELOPMENT_ONLY = ["TYPST_BIN", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_VISION_MODEL"];

const OPTIONAL = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "APPLICATION_WORKER_USER_ID",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REDIRECT_URI",
  "GMAIL_TOKEN_ENCRYPTION_KEY",
  "USAJOBS_API_KEY",
  "USAJOBS_USER_AGENT",
  "GOOGLE_PLACES_API_KEY",
];

const ALL = [...VERCEL_PRODUCTION, ...LOCAL_AGENT_ONLY, ...LOCAL_DEVELOPMENT_ONLY, ...OPTIONAL];

/**
 * Values that must never reach browser JavaScript. Next.js inlines any
 * NEXT_PUBLIC_-prefixed variable into the client bundle, so prefixing one of
 * these would publish it to every visitor.
 */
const SECRETS = [
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "INTERNSHIP_AGENT_TOKEN",
  // Signs session cookies; in the browser bundle it would be a forgery kit.
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_TOKEN_ENCRYPTION_KEY",
  "USAJOBS_API_KEY",
  "GOOGLE_PLACES_API_KEY",
];

describe(".env.example", () => {
  it("names every variable the application reads", async () => {
    const template = await repoFile(".env.example");

    for (const name of ALL) {
      expect(template, `${name} is missing from .env.example`).toContain(name);
    }
  });

  it("carries no real secret", async () => {
    const template = await repoFile(".env.example");

    for (const name of SECRETS) {
      const assigned = new RegExp(`^${name}=(.*)$`, "m").exec(template);
      if (!assigned) continue;
      const value = assigned[1].trim().replace(/^["']|["']$/g, "");
      expect(value, `${name} must be blank or an obvious placeholder`).toMatch(
        /^$|placeholder|example|user:password/i,
      );
    }
  });
});

describe("DEPLOYMENT_ENVIRONMENT.md", () => {
  it("classifies every variable", async () => {
    const doc = await repoFile("DEPLOYMENT_ENVIRONMENT.md");

    for (const name of ALL) {
      expect(doc, `${name} is not classified in DEPLOYMENT_ENVIRONMENT.md`).toContain(name);
    }
  });
});

describe("client-side exposure", () => {
  it("prefixes no secret with NEXT_PUBLIC_", async () => {
    const template = await repoFile(".env.example");

    for (const name of SECRETS) {
      expect(template).not.toContain(`NEXT_PUBLIC_${name}`);
    }
  });

  it("reads secrets only from server modules", async () => {
    // A "use client" module that reads one of these would inline it into the
    // browser bundle. The token names below are the ones that would be worth
    // stealing.
    const clientModules = [
      "src/lib/ollamaHealthClient.ts",
      "src/lib/applications/extensionBridge.ts",
      "src/lib/applications/localAgentClient.ts",
      "src/components/OllamaStatusBadge.tsx",
    ];
    for (const file of clientModules) {
      const source = await repoFile(file);
      for (const name of SECRETS) {
        expect(source, `${file} must not read ${name}`).not.toContain(name);
      }
    }
  });
});
