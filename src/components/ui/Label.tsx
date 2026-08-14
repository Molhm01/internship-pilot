import { cn } from "./cn";

/**
 * The uppercase micro label.
 *
 * This is the single most characteristic element of the system: it is what
 * makes a screen read as an instrument rather than a marketing page. Used for
 * section headings, metric captions, and table column heads.
 */
export function Label({
  children,
  className,
  as: Tag = "h2",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "h1" | "h2" | "h3" | "h4" | "p" | "span" | "div";
}) {
  return (
    <Tag
      className={cn(
        "text-micro font-medium uppercase tracking-[0.075em] text-tertiary",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * Monospaced value text. Every ID, count, timestamp, score and measurement in
 * this product should use it — tabular figures stop columns from twitching as
 * values refresh, which they do constantly here.
 */
export function Mono({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("font-mono tabular text-[0.9em]", className)}>{children}</span>
  );
}
