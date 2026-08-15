import { isCloudRuntime } from "@/lib/runtime/deployment";

/**
 * The canonical, externally reachable origin of this Internship Pilot install.
 *
 * `http://localhost:3000` was hard-coded in two places that both leave the
 * process: `metadataBase` (which turns every relative Open Graph image into an
 * absolute URL) and the Gmail OAuth redirect. Deployed, both would have
 * pointed Google and every social crawler at the visitor's own machine.
 *
 * Resolution order is "what the operator said" → "what the platform knows" →
 * "the development default", and the development default is only offered in
 * development. A production build that cannot name itself is a configuration
 * error worth failing on, not something to paper over with a localhost guess.
 */
export class AppUrlNotConfiguredError extends Error {
  readonly code = "APP_URL_NOT_CONFIGURED";

  constructor() {
    super(
      "NEXT_PUBLIC_APP_URL is not set. Set it to this deployment's public HTTPS origin, for example https://internship-pilot.vercel.app.",
    );
    this.name = "AppUrlNotConfiguredError";
  }
}

const DEVELOPMENT_APP_URL = "http://localhost:3000";

function normalize(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(withScheme).origin;
}

/**
 * Resolves the canonical origin, or `null` when nothing is configured and no
 * safe fallback exists. Callers that must have a value use `appUrl()`.
 */
export function resolveAppUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      return normalize(configured);
    } catch {
      return null;
    }
  }

  // Vercel exposes the stable production hostname and the per-deployment one.
  // The production alias is preferred so preview builds do not advertise a URL
  // that stops resolving as soon as the next deployment lands.
  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  if (vercelHost) {
    try {
      return normalize(vercelHost);
    } catch {
      return null;
    }
  }

  // Local development, and only local development, gets the localhost default.
  if (!isCloudRuntime() && process.env.NODE_ENV !== "production") return DEVELOPMENT_APP_URL;

  return null;
}

/** The canonical origin. Throws when a deployment has not been told its URL. */
export function appUrl(): string {
  const resolved = resolveAppUrl();
  if (!resolved) throw new AppUrlNotConfiguredError();
  return resolved;
}

/** Absolute URL for a path on this install, e.g. an OAuth callback. */
export function absoluteAppUrl(pathname: string): string {
  return new URL(pathname, `${appUrl()}/`).toString();
}
