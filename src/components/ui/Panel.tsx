import { cn } from "./cn";
import { Label } from "./Label";

/**
 * Grouping surfaces.
 *
 * The old UI reached for `bg-white rounded-xl border p-6` for every group on
 * every page, which is what produced the stacked-card look. The replacement is
 * two components with a clear rule about which to use:
 *
 *   Section — the DEFAULT. Groups with a heading and a hairline rule, no box.
 *   Panel   — only when content genuinely needs to be enclosed: a table, an
 *             editable form, a distinct object like a job or a run.
 *
 * If a screen has more than two or three Panels, that is a signal the content
 * wants Sections instead.
 */

export type SectionProps = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

export function Section({ title, description, actions, children, className }: SectionProps) {
  return (
    <section className={cn("space-y-4", className)}>
      {(title || actions || description) && (
        <div className="flex items-end justify-between gap-6 border-b border-hairline pb-2.5">
          <div className="min-w-0 space-y-1">
            {title && <Label>{title}</Label>}
            {description && (
              <p className="text-small text-secondary max-w-prose">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export type PanelProps = {
  children: React.ReactNode;
  className?: string;
  /** Removes internal padding — for tables and lists that manage their own. */
  flush?: boolean;
  tone?: "default" | "sunken" | "accent" | "critical" | "caution";
};

const PANEL_TONES: Record<NonNullable<PanelProps["tone"]>, string> = {
  default: "bg-surface border-hairline",
  sunken: "bg-sunken border-hairline",
  accent: "bg-accent-quiet border-accent-line",
  critical: "bg-critical-quiet border-critical-line",
  caution: "bg-caution-quiet border-caution-line",
};

export function Panel({ children, className, flush, tone = "default", ...rest }: PanelProps) {
  return (
    <div
      className={cn(
        "rounded-lg border",
        PANEL_TONES[tone],
        !flush && "p-4",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-hairline px-4 py-2.5",
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-small font-medium text-primary">{title}</h3>
        {description && <p className="text-small text-tertiary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}
