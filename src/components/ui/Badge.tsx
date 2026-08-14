import { cn } from "./cn";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "positive"
  | "caution"
  | "critical"
  | "info";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-n-100 text-secondary border-n-200",
  accent: "bg-accent-quiet text-accent-text border-accent-line",
  positive: "bg-positive-quiet text-positive border-positive-line",
  caution: "bg-caution-quiet text-caution border-caution-line",
  critical: "bg-critical-quiet text-critical border-critical-line",
  info: "bg-info-quiet text-info border-info-line",
};

const DOT_TONES: Record<BadgeTone, string> = {
  neutral: "bg-n-400",
  accent: "bg-accent",
  positive: "bg-positive",
  caution: "bg-caution",
  critical: "bg-critical",
  info: "bg-info",
};

/**
 * Square-ish, not a pill. Pill badges at every density level are a large part
 * of what made the old UI read as generic; the 3px radius keeps them reading as
 * tags on an instrument.
 */
export function Badge({
  tone = "neutral",
  children,
  className,
  dot,
  title,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
  /** Shows a status dot — for live/eventful states rather than static labels. */
  dot?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5",
        "text-micro font-medium uppercase tracking-[0.06em] whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {dot && (
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT_TONES[tone])} aria-hidden />
      )}
      {children}
    </span>
  );
}
