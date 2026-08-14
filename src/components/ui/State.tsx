import { cn } from "./cn";
import { Button } from "./Button";

/**
 * Loading, empty and error states.
 *
 * Phase 14 covers these properly across every screen; these are the primitives
 * it will use. They exist now so migrated pages stop hand-rolling
 * `<p className="text-sm text-slate-500">Loading…</p>`, which is what every
 * page currently does and why no two loading states match.
 */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-sm bg-n-100", className)}
      aria-hidden
    />
  );
}

/** Skeleton shaped like a list of rows, for feeds and tables. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-hairline py-3">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-1/5" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-y border-hairline px-4 py-12 text-center", className)}>
      <p className="text-subhead text-primary">{title}</p>
      {description && (
        <p className="mx-auto mt-1.5 max-w-md text-small text-secondary">{description}</p>
      )}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * An error that the user can act on. `onRetry` is wired by the caller because
 * every failing surface in this app has a different retry (reload jobs, rerun
 * a match, re-fetch counts) and a generic reload would be wrong for most.
 */
export function ErrorState({
  title = "Something failed",
  message,
  onRetry,
  retryLabel = "Retry",
  className,
}: {
  title?: React.ReactNode;
  message: React.ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start justify-between gap-4 rounded-lg border border-critical-line bg-critical-quiet px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-small font-medium text-critical">{title}</p>
        <p className="text-small text-secondary">{message}</p>
      </div>
      {onRetry && (
        <Button variant="danger" size="sm" onClick={onRetry} className="shrink-0">
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

/** Inline notice — for non-blocking context, not failures. */
export function Notice({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "caution" | "positive";
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-info-line bg-info-quiet text-info",
    caution: "border-caution-line bg-caution-quiet text-caution",
    positive: "border-positive-line bg-positive-quiet text-positive",
  } as const;
  return (
    <div className={cn("rounded-md border px-3 py-2 text-small", tones[tone], className)}>
      {children}
    </div>
  );
}
