import { badgeFor, type BadgeKind } from "@/lib/jobs/verificationModel";

// Compact availability badges shown on every job card (there is no separate
// hidden "Needs Review" pool). Distinguishes VISIBILITY/availability from
// official-destination verification.
const BADGE: Record<BadgeKind, { style: string; label: string; title: string }> = {
  official_verified: {
    style: "bg-emerald-100 text-emerald-800 border-emerald-300",
    label: "✓ Official destination verified",
    title: "The official employer application page was independently confirmed at the last check.",
  },
  source_listed: {
    style: "bg-sky-100 text-sky-800 border-sky-300",
    label: "Source listed",
    title: "Currently listed on the discovery source (Jobright/Simplify/Intern List). Official destination not yet independently verified — still active and applyable.",
  },
  verification_pending: {
    style: "bg-amber-100 text-amber-800 border-amber-300",
    label: "Verification pending",
    title: "A destination check is queued or was temporarily inconclusive. Still active and applyable.",
  },
  closed_confirmed: {
    style: "bg-rose-100 text-rose-700 border-rose-300",
    label: "Closed confirmed",
    title: "The destination explicitly reported the posting as closed/removed (404/410).",
  },
  destination_mismatch: {
    style: "bg-orange-100 text-orange-800 border-orange-300",
    label: "Destination mismatch",
    title: "The final destination clearly has a different company/title/job id.",
  },
  security_blocked: {
    style: "bg-rose-200 text-rose-900 border-rose-400",
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
