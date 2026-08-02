export type InitialMatchUiStatus = "Scoring" | "Scoring delayed" | "Not scored" | null;

export function initialMatchUiStatus(
  scoringState: string | null | undefined,
  hasValidMatch: boolean,
): InitialMatchUiStatus {
  if (hasValidMatch) return null;
  if (["QUEUED", "SCORING"].includes(scoringState ?? "")) return "Scoring";
  if (scoringState === "RETRYABLE_FAILED") return "Scoring delayed";
  return "Not scored";
}
