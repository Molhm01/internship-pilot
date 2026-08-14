import { cn } from "./cn";

/**
 * Page header.
 *
 * Every page in the app uses this, which is what makes the top of each screen
 * align to the same baseline. The old pages each declared their own
 * `<header>` with slightly different margins and title sizes.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Small technical metadata shown under the title — counts, sync time, ids. */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-heading text-primary">{title}</h1>
          {description && (
            <p className="mt-1.5 max-w-2xl text-small text-secondary text-pretty">{description}</p>
          )}
          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-micro text-faint">
              {meta}
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
    </header>
  );
}

/** Standard page padding. Keeps gutters identical across every route. */
export function PageBody({
  children,
  className,
  width = "wide",
}: {
  children: React.ReactNode;
  className?: string;
  width?: "wide" | "narrow" | "full";
}) {
  return (
    <div
      className={cn(
        "px-5 py-7 md:px-7",
        width === "wide" && "mx-auto max-w-[80rem]",
        width === "narrow" && "mx-auto max-w-3xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
