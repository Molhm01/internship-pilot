"use client";

import { Toaster, toast } from "sonner";
import { CheckCircle2, AlertTriangle, XCircle, Info, Loader2 } from "lucide-react";

/**
 * Toast host.
 *
 * Sonner supplies the queue, positioning and a11y announcements; every visual
 * token is overridden so it does not read as a stock library component. Icons
 * are explicit because state must never be communicated by colour alone
 * (section 66).
 */
export function ToastHost() {
  return (
    <Toaster
      position="bottom-right"
      gap={8}
      offset={16}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "group flex w-[22rem] items-start gap-2.5 rounded-lg border border-line bg-overlay px-3 py-2.5 shadow-overlay backdrop-blur-sm",
          title: "text-small font-medium text-primary",
          description: "text-small text-secondary mt-0.5",
          actionButton:
            "ml-auto shrink-0 rounded-md border border-line px-2 py-1 text-micro font-medium text-primary hover:bg-n-200 transition-colors",
          cancelButton:
            "shrink-0 rounded-md px-2 py-1 text-micro font-medium text-tertiary hover:text-primary transition-colors",
        },
      }}
      icons={{
        success: <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-verified" aria-hidden />,
        warning: <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />,
        error: <XCircle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />,
        info: <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />,
        loading: (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent" aria-hidden />
        ),
      }}
    />
  );
}

export { toast };
