/**
 * Client-safe auth constants.
 *
 * This module imports nothing server-only (no `node:crypto`), so it is safe to
 * import from client components. `password.ts` — which DOES pull in Node crypto
 * — re-exports these, but client code must import them from here to avoid
 * dragging a server module into the browser bundle.
 */
export const MINIMUM_PASSWORD_LENGTH = 10;
export const MAXIMUM_PASSWORD_LENGTH = 200;
