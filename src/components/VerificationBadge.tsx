import { badgeFor, type BadgeKind } from "@/lib/jobs/verificationModel";

// Compact availability badges shown on every job card (there is no separate
// hidden "Needs Review" pool). Distinguishes VISIBILITY/availability from
// official-destination verification.
const BADGE: Record<BadgeKind, { style: string; label: string; title: string }> = {
  official_verified: {
    style: "bg-verified-quiet text-verified border-verified-line",
    label: "✓ Official destination verified",
    title: "The official employer application page was independently confirmed at the last check.",
  },
  source_listed: {
    style: "bg-info-quiet text-info border-info-line",
    label: "Source listed",
    title: "Currently listed on the discovery source (Jobright/Simplify/Intern List). Official destination not yet independently verified — still active and applyable.",
  },
  verification_pending: {
    style: "bg-caution-quiet text-caution border-caution-line",
    label: "Verification pending",
    title: "A destination check is queued or was temporarily inconclusive. Still active and applyable.",
  },
  closed_confirmed: {
    style: "bg-critical-quiet text-critical border-critical-line",
    label: "Closed confirmed",
    title: "The destination explicitly reported the posting as closed/removed (404/410).",
  },
  destination_mismatch: {
    style: "bg-caution-quiet text-caution border-caution-line",
    label: "Destination mismatch",
    title: "The final destination clearly has a different company/title/job id.",
  },
  security_blocked: {
    style: "bg-critical-quiet text-critical border-critical-line",
    label: "Security blocked",
    title: "The destination appears fraudulent/malicious or violates the application safety policy.",
  },
};

export default function VerificationBadge({ status }: { status: string }) {
  const b = BADGE[badgeFor(status)];
  return (
    <span title={b.title} className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${b.style}`}>
      {b.label}
    </span>
  );
}

// The posting-age formatter used to live here with day-only resolution, which
// rendered every posting under 24 hours old as "today". It now lives in
// src/lib/jobs/postedAge.ts with minute/hour resolution, driven by
// Job.sourcePostedAt.
