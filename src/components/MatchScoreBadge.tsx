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
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : score >= 50
        ? "bg-amber-100 text-amber-800 border-amber-300"
        : "bg-rose-100 text-rose-800 border-rose-300";

  const eligibilityColor =
    normalizedEligibility === "pass"
      ? "text-emerald-700"
      : normalizedEligibility === "fail"
        ? "text-rose-700"
        : "text-slate-500";

  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center justify-center rounded-full border w-11 h-11 text-sm font-bold ${color}`}>
        {score}
      </span>
      <span className={`text-xs font-medium ${eligibilityColor}`}>{eligibility}</span>
    </div>
  );
}
