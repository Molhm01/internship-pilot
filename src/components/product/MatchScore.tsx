import { cn } from "@/components/ui/cn";

/** ATS-style resume-to-job match score. */
export type MatchTone = "strong" | "moderate" | "weak";

export function matchTone(score: number): MatchTone {
  if (score >= 75) return "strong";
  if (score >= 50) return "moderate";
  return "weak";
}

const TONE_TEXT: Record<MatchTone, string> = {
  strong: "text-verified",
  moderate: "text-caution",
  weak: "text-critical",
};

const TONE_STROKE: Record<MatchTone, string> = {
  strong: "stroke-verified",
  moderate: "stroke-caution",
  weak: "stroke-critical",
};

const SIZES = {
  sm: { box: 30, stroke: 2.5, text: "text-micro" },
  md: { box: 40, stroke: 3, text: "text-small" },
  lg: { box: 60, stroke: 3.5, text: "text-subhead" },
} as const;

export function MatchScore({
  score,
  size = "md",
  className,
  label,
}: {
  score: number;
  size?: keyof typeof SIZES;
  className?: string;
  label?: string;
}) {
  const tone = matchTone(score);
  const { box, stroke, text } = SIZES[size];
  const radius = (box - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - clamped / 100);

  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      title={label ?? `ATS Match score ${score} of 100`}
    >
      <svg width={box} height={box} className="-rotate-90" aria-hidden>
        <circle
          cx={box / 2}
          cy={box / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-n-200"
        />
        <circle
          cx={box / 2}
          cy={box / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn(TONE_STROKE[tone], "transition-[stroke-dashoffset] duration-700 ease-standard")}
        />
      </svg>
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center font-mono font-medium tabular",
          text,
          TONE_TEXT[tone],
        )}
      >
        {Math.round(clamped)}%
      </span>
      <span className="sr-only">Match score {score} percent</span>
    </span>
  );
}

export function EligibilityTag({
  eligibility,
  className,
}: {
  eligibility: string;
  className?: string;
}) {
  const normalized = eligibility.toLowerCase();
  const tone =
    normalized === "pass"
      ? "border-verified-line bg-verified-quiet text-verified"
      : normalized === "fail"
        ? "border-critical-line bg-critical-quiet text-critical"
        : "border-line bg-sunken text-tertiary";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-micro font-medium uppercase tracking-[0.06em] whitespace-nowrap",
        tone,
        className,
      )}
    >
      {eligibility}
    </span>
  );
}
