export type ManualMatchResult = {
  id: string;
  score: number;
  eligibility: string;
};

const MISSING_DESCRIPTION_VALUES = new Set([
  "n/a",
  "na",
  "none",
  "unknown",
  "no description",
  "no description available",
  "description unavailable",
]);

export function hasUsableJobDescription(description: string | null | undefined): boolean {
  const normalized = description?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
  return normalized.length > 0 && !MISSING_DESCRIPTION_VALUES.has(normalized);
}

export class MatchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchRequestError";
  }
}

export async function requestManualMatch(
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<ManualMatchResult> {
  const response = await fetcher("/api/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MatchRequestError(
      response.ok
        ? "AI Match completed without returning a readable result."
        : "AI Match failed without returning a readable error.",
    );
  }

  const data = payload && typeof payload === "object"
    ? payload as { error?: unknown; matchResult?: unknown }
    : {};

  if (!response.ok) {
    throw new MatchRequestError(
      typeof data.error === "string" && data.error.trim()
        ? data.error
        : "Could not run AI Match.",
    );
  }

  const result = data.matchResult;
  if (
    !result
    || typeof result !== "object"
    || typeof (result as ManualMatchResult).id !== "string"
    || typeof (result as ManualMatchResult).score !== "number"
    || typeof (result as ManualMatchResult).eligibility !== "string"
  ) {
    throw new MatchRequestError("AI Match completed without returning a valid result.");
  }

  return result as ManualMatchResult;
}
