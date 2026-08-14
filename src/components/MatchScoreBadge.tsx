export default function MatchScoreBadge({
  score,
  eligibility,
}: {
  score: number;
  eligibility: string;
}) {
  const normalizedEligibility = eligibility.toLowerCase();
  const color =
    score >= 75
      ? "bg-verified-quiet text-verified border-verified-line"
      : score >= 50
        ? "bg-caution-quiet text-caution border-caution-line"
        : "bg-critical-quiet text-critical border-critical-line";

  const eligibilityColor =
    normalizedEligibility === "pass"
      ? "text-verified"
      : normalizedEligibility === "fail"
        ? "text-critical"
        : "text-tertiary";

  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center justify-center rounded-full border w-11 h-11 text-sm font-bold ${color}`}>
        {score}
      </span>
      <span className={`text-xs font-medium ${eligibilityColor}`}>{eligibility}</span>
    </div>
  );
}
