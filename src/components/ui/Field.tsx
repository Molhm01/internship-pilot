import { cn } from "./cn";

/**
 * Form controls.
 *
 * Consolidates the three separate `Field` helpers that were independently
 * declared inside jobs/page.tsx, documents/page.tsx and
 * approved-employers/page.tsx.
 */

const CONTROL_BASE =
  "w-full bg-surface text-primary border border-line rounded-md " +
  "placeholder:text-faint " +
  "transition-colors duration-[120ms] ease-standard " +
  "hover:border-line-strong " +
  "focus:outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-quiet " +
  "disabled:bg-sunken disabled:text-faint disabled:cursor-not-allowed";

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input className={cn(CONTROL_BASE, "h-7 px-2 text-small", className)} {...props} />
  );
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(CONTROL_BASE, "px-2 py-1.5 text-small leading-relaxed", className)}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(CONTROL_BASE, "h-7 px-1.5 text-small", className)} {...props}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <label
        htmlFor={htmlFor}
        className="block text-micro font-medium uppercase tracking-[0.075em] text-tertiary"
      >
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-small text-tertiary">{hint}</p>}
      {error && (
        <p className="text-small text-critical" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
