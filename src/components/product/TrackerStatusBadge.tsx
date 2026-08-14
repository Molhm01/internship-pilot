import { STATUS_LABELS, type TrackerStatus } from "@/lib/statuses";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

/**
 * Tracker status badge.
 *
 * `lib/statuses.ts` still owns the vocabulary and the labels; this file owns
 * only how each status is toned. That split matters because STATUS_COLORS in
 * that file is a set of light-theme Tailwind class strings — mapping to design
 * tokens here means the status vocabulary stays a logic concern and theming
 * stays a presentation concern.
 */
const TONES: Record<TrackerStatus, BadgeTone> = {
  DISCOVERED: "neutral",
  VERIFIED: "info",
  INELIGIBLE: "neutral",
  TAILORING: "caution",
  DOCUMENT_QA: "caution",
  READY_TO_APPLY: "accent",
  QUEUED: "info",
  APPLYING: "accent",
  NEEDS_USER_ACTION: "caution",
  SUBMITTED: "info",
  ASSESSMENT_REQUIRED: "info",
  INTERVIEW: "accent",
  REJECTED: "critical",
  OFFER: "positive",
  CLOSED: "neutral",
  FAILED: "critical",
};

/** States where something is actively happening, so the badge shows a dot. */
const LIVE = new Set<TrackerStatus>(["APPLYING", "QUEUED", "TAILORING", "NEEDS_USER_ACTION"]);

export function TrackerStatusBadge({ status, className }: { status: string; className?: string }) {
  const key = status as TrackerStatus;
  const tone = TONES[key] ?? "neutral";
  const label = STATUS_LABELS[key] ?? status;
  return (
    <Badge tone={tone} dot={LIVE.has(key)} className={className}>
      {label}
    </Badge>
  );
}
