import { cn } from "./cn";

/**
 * Dense data table.
 *
 * Horizontal rules only — no vertical grid lines, no zebra striping, no cell
 * borders. Column separation comes from alignment and spacing, which is what
 * lets a table carry 11 columns (the approved-employers table does) without
 * turning into a grid of boxes.
 */

export function Table({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-small", className)}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return <thead>{children}</thead>;
}

export function TR({
  children,
  className,
  interactive,
}: {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <tr
      className={cn(
        "border-b border-hairline last:border-0",
        interactive && "transition-colors duration-[120ms] ease-standard hover:bg-n-50",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TH({
  children,
  className,
  align = "left",
}: {
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-line px-2.5 py-1.5 align-bottom",
        "text-micro font-medium uppercase tracking-[0.075em] text-tertiary whitespace-nowrap",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  className,
  align = "left",
  numeric,
}: {
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  /** Renders monospaced and right-aligned — for counts, scores and dates. */
  numeric?: boolean;
}) {
  return (
    <td
      className={cn(
        "px-2.5 py-2 align-top text-secondary",
        numeric && "font-mono tabular text-right text-primary",
        !numeric && align === "right" && "text-right",
        !numeric && align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}
