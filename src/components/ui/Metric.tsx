import { cn } from "./cn";

export type MetricTone = "default" | "accent" | "positive" | "caution" | "critical" | "info";

const VALUE_TONES: Record<MetricTone, string> = {
  default: "text-primary",
  accent: "text-accent-text",
  positive: "text-positive",
  caution: "text-caution",
  critical: "text-critical",
  info: "text-info",
};

/**
 * A single readout: large tabular value over a micro caption.
 *
 * Replaces the bordered count tile. Eleven bordered boxes in a grid is eleven
 * containers competing with the numbers inside them; a divided readout row puts
 * the weight on the values, which is the actual information.
 */
export function Metric({
  label,
  value,
  tone = "default",
  hint,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: MetricTone;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 px-3 py-2 first:pl-0", className)} title={typeof hint === "string" ? hint : undefined}>
      <div className={cn("font-mono tabular text-[1.375rem] leading-none font-medium", VALUE_TONES[tone])}>
        {value}
      </div>
      <div className="mt-1.5 truncate text-micro font-medium uppercase tracking-[0.075em] text-tertiary">
        {label}
      </div>
    </div>
  );
}

/**
 * Lays metrics out in a row divided by hairlines rather than in a card grid.
 * Wraps on narrow viewports without collapsing into a single column, so the
 * readout stays scannable.
 */
export function MetricRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-stretch",
        "[&>*]:border-l [&>*]:border-hairline [&>*:first-child]:border-l-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
