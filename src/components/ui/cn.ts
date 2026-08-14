/**
 * Minimal class joiner.
 *
 * Deliberately not clsx + tailwind-merge. The primitives in this folder are
 * written so that caller classes are appended last and conflicts are avoided by
 * construction rather than resolved at runtime, which keeps two dependencies
 * out of a local-first app for a gain it would not actually realise here.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
