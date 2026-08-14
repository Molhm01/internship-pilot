import { CheckCircle2, Circle, Clock, XCircle, AlertTriangle, ShieldAlert } from "lucide-react";
import { badgeFor, type BadgeKind } from "@/lib/jobs/verificationModel";
import { cn } from "@/components/ui/cn";

/**
 * Availability / verification badge.
 *
 * Wraps the unchanged `badgeFor()` mapping, so the six states and their meanings
 * are exactly as before. The copy is shortened for the card grid and the full
 * explanation moves to the tooltip — the old labels ("✓ Official destination
 * verified") were long enough to wrap and dominate the card.
 *
 * Each state carries its own icon: state is never signalled by colour alone.
 */
const BADGE: Record<
  BadgeKind,
  { label: string; title: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  official_verified: {
    label: "Verified",
    title:
      "The official employer application page was independently confirmed at the last check.",
    className: "border-verified-line bg-verified-quiet text-verified",
    icon: CheckCircle2,
  },
  source_listed: {
    label: "Source listed",
    title:
      "Currently listed on the discovery source. Official destination not yet independently verified — still active and applyable.",
    className: "border-info-line bg-info-quiet text-info",
    icon: Circle,
  },
  verification_pending: {
    label: "Pending",
    title:
      "A destination check is queued or was temporarily inconclusive. Still active and applyable.",
    className: "border-caution-line bg-caution-quiet text-caution",
    icon: Clock,
  },
  closed_confirmed: {
    label: "Closed",
    title: "The destination explicitly reported the posting as closed or removed.",
    className: "border-critical-line bg-critical-quiet text-critical",
    icon: XCircle,
  },
  destination_mismatch: {
    label: "Mismatch",
    title: "The final destination clearly has a different company, title or job id.",
    className: "border-caution-line bg-caution-quiet text-caution",
    icon: AlertTriangle,
  },
  security_blocked: {
    label: "Blocked",
    title:
      "The destination appears fraudulent or malicious, or violates the application safety policy.",
    className: "border-critical-line bg-critical-quiet text-critical",
    icon: ShieldAlert,
  },
};

export function AvailabilityBadge({
  status,
  className,
  showLabel = true,
}: {
  status: string;
  className?: string;
  showLabel?: boolean;
}) {
  const badge = BADGE[badgeFor(status)];
  const Icon = badge.icon;
  return (
    <span
      title={badge.title}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
        "text-micro font-medium uppercase tracking-[0.06em] whitespace-nowrap",
        badge.className,
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {showLabel && badge.label}
      <span className="sr-only">{badge.title}</span>
    </span>
  );
}
