import { cn } from "@/components/ui/cn";

/**
 * Product mark.
 *
 * A stylised aperture/heading indicator rather than a letterform monogram —
 * closer to an instrument glyph than a startup logo, which is what the rest of
 * the visual language is doing.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("size-5", className)}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.4" opacity="0.35" />
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M12 2.75V7M12 17v4.25M2.75 12H7M17 12h4.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" />
    </svg>
  );
}

export function Wordmark({
  className,
  compact,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("flex items-center gap-2 text-primary", className)}>
      <Mark className="shrink-0 text-accent" />
      {!compact && (
        <span className="text-small font-medium tracking-[-0.01em] whitespace-nowrap">
          Internship Pilot
        </span>
      )}
    </span>
  );
}
