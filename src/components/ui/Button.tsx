import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  // Flat fills only. No gradient, no shadow, no glow — the press state is a
  // colour step, which reads as mechanical rather than soft.
  primary:
    "bg-accent text-inverse border border-accent hover:bg-accent-hover active:bg-accent-active disabled:bg-n-300 disabled:border-n-300",
  secondary:
    "bg-surface text-primary border border-line hover:border-line-strong hover:bg-n-50 active:bg-n-100",
  ghost:
    "bg-transparent text-secondary border border-transparent hover:bg-n-100 hover:text-primary active:bg-n-150",
  danger:
    "bg-surface text-critical border border-critical-line hover:bg-critical-quiet active:bg-critical-quiet",
};

const SIZES: Record<ButtonSize, string> = {
  // Not uppercased. Uppercase micro is the Badge and Label role; using it here
  // too made the size scale read as three unrelated styles.
  sm: "h-6 px-2 text-micro gap-1.5",
  md: "h-7 px-2.5 text-small gap-1.5",
  lg: "h-[34px] px-3.5 text-body gap-2",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap",
        "transition-colors duration-[120ms] ease-standard",
        "disabled:cursor-not-allowed disabled:opacity-55",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

/**
 * A link that carries button weight. Kept separate from Button rather than
 * given an `asChild` prop — this codebase has exactly two cases and a
 * polymorphic component would cost more than it saves.
 */
export type ButtonLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonLinkProps) {
  return (
    <a
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap",
        "transition-colors duration-[120ms] ease-standard",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
