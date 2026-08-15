/**
 * Where this Next.js process is actually running.
 *
 * Internship Pilot is deliberately split in two. The website is online; the
 * Application Agent, Ollama, Typst, and Playwright all live on the user's own
 * computer. Every one of those is reached over loopback, which is correct
 * exactly as long as the web server and the user share a machine.
 *
 * Once the website is deployed, `127.0.0.1` stops meaning "the user's PC" and
 * starts meaning "this serverless function". A request to
 * http://127.0.0.1:4317 from Vercel does not fail in an obvious way — it
 * either hangs until the function times out or returns ECONNREFUSED, and the
 * user is told their agent is broken when the truth is that the server was
 * never able to reach it in the first place.
 *
 * So the runtime location is a first-class fact, checked before any loopback
 * call is attempted, and the answer the user gets is the true one: this
 * feature runs on your computer, and this server is not your computer.
 */

export type RuntimeLocation = "local" | "cloud";

/**
 * `cloud` means "co-located with nothing the user owns". It is inferred from
 * the platform and can always be stated outright, because a self-hosted box
 * that genuinely does sit next to the agent must be able to say so.
 */
export function runtimeLocation(): RuntimeLocation {
  const declared = process.env.INTERNSHIP_PILOT_RUNTIME?.trim().toLowerCase();
  if (declared === "cloud" || declared === "local") return declared;
  // Vercel sets VERCEL=1 in every build and runtime environment it owns.
  if (process.env.VERCEL === "1" || process.env.VERCEL === "true") return "cloud";
  return "local";
}

export function isCloudRuntime(): boolean {
  return runtimeLocation() === "cloud";
}

export function isLocalRuntime(): boolean {
  return runtimeLocation() === "local";
}

/**
 * A capability that only exists when the server and the user share a machine.
 * Thrown rather than returned so a caller cannot forget to check.
 */
export class LocalOnlyFeatureError extends Error {
  readonly code: string;
  readonly feature: LocalOnlyFeature;

  constructor(feature: LocalOnlyFeature, code = "LOCAL_RUNTIME_REQUIRED") {
    super(LOCAL_ONLY_FEATURES[feature]);
    this.name = "LocalOnlyFeatureError";
    this.code = code;
    this.feature = feature;
  }
}

/**
 * Every local-only capability, with the message the user actually sees. These
 * are written as statements of where the work happens, not as failures.
 */
export const LOCAL_ONLY_FEATURES = {
  ollama:
    "Local AI is offline. Internship Pilot runs its AI on your own computer with Ollama, and this website cannot reach it. Start the local Internship Agent and Ollama, then connect them from this browser.",
  localAgent:
    "The local Internship Agent runs on your computer, so this website cannot contact it directly. Use the Internship Pilot browser extension — it is the bridge between this page and your agent.",
  typst:
    "Tailored documents are compiled by Typst on your own computer. Run Internship Pilot locally, or use the local Internship Agent, to generate them.",
  playwright:
    "The browser automation agent runs on your own computer. This website cannot drive a browser on your machine.",
  childProcess:
    "This diagnostic runs a command on the machine hosting Internship Pilot, which is only meaningful in local development.",
} as const;

export type LocalOnlyFeature = keyof typeof LOCAL_ONLY_FEATURES;

/** Throws in cloud runtimes; a no-op locally. */
export function assertLocalRuntime(feature: LocalOnlyFeature, code?: string): void {
  if (isCloudRuntime()) throw new LocalOnlyFeatureError(feature, code);
}

/**
 * What this deployment can and cannot do, in the shape the browser needs to
 * render an honest UI. Contains no secrets — every field is derived from the
 * runtime location alone.
 */
export type RuntimeCapabilities = {
  runtime: RuntimeLocation;
  /** Server-side Ollama inference (AI Match, résumé analysis, bullets, Gmail). */
  serverSideAi: boolean;
  /** Server-to-agent loopback calls (document delivery, application sessions). */
  serverSideLocalAgent: boolean;
  /** Typst compilation of tailored PDFs on the server. */
  serverSideDocumentGeneration: boolean;
  /** Playwright-driven application runs on the server. */
  serverSideBrowserAutomation: boolean;
  /** In cloud runtimes the extension is the only route to the local agent. */
  requiresExtensionBridge: boolean;
};

export function runtimeCapabilities(): RuntimeCapabilities {
  const cloud = isCloudRuntime();
  return {
    runtime: cloud ? "cloud" : "local",
    serverSideAi: !cloud,
    serverSideLocalAgent: !cloud,
    serverSideDocumentGeneration: !cloud,
    serverSideBrowserAutomation: !cloud,
    requiresExtensionBridge: cloud,
  };
}
