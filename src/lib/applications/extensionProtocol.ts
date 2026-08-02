// Server/extension compatibility handshake.
//
// Bump EXTENSION_PROTOCOL_VERSION whenever the message shapes exchanged
// between the extension (background.js / content.js) and the local
// /api/extension/* endpoints change in an incompatible way. The extension
// mirrors this number; the popup shows both and refuses to run a fill when
// they differ, instead of failing mysteriously mid-run.
export const EXTENSION_PROTOCOL_VERSION = 2;

// Human-readable build tag, surfaced in the health response and popup so a
// stale server vs. new extension mismatch is immediately visible.
export const SERVER_BUILD = "internship-pilot-2026.07.24";
