/**
 * Only an internal, single-segment-leading path is a safe post-auth
 * destination. Anything else (a bare protocol-relative "//evil.com", an
 * absolute URL, or a missing leading slash) is rejected in favor of the
 * default — the `next` query param is attacker-controlled input reflected
 * straight from the URL a user clicked.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}
