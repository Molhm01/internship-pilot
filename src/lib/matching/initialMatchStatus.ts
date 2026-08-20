export type InitialMatchUiStatus =
  | "Preparing job details"
  | "Scoring"
  | "Scoring delayed"
  | "Not scored"
  | null;

export function initialMatchUiStatus(
  scoringState: string | null | undefined,
  hasValidMatch: boolean,
): InitialMatchUiStatus {
  if (hasValidMatch) return null;
  if (scoringState === "DESCRIPTION_PENDING") return "Preparing job details";
  if (["QUEUED", "SCORING"].includes(scoringState ?? "")) return "Scoring";
  if (scoringState === "RETRYABLE_FAILED") return "Scoring delayed";
  return "Not scored";
}
