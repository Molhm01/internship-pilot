export type ManualMatchResult = {
  id: string;
  score: number;
  eligibility: string;
};

export type MatchDescriptionSource = string | null | undefined | {
  description?: string | null;
  jobResponsibilities?: string | null;
  jobQualifications?: string | null;
};

export const MIN_MATCH_DESCRIPTION_CHARS = 120;

const MISSING_DESCRIPTION_VALUES = new Set([
  "n/a",
  "na",
  "none",
  "unknown",
  "no description",
  "no description available",
  "description unavailable",
]);

function parseStoredDescriptionList(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    // Some legacy rows stored plain text instead of a JSON string array.
  }
  return [value.trim()];
}

export function matchJobDescriptionText(source: MatchDescriptionSource): string {
  if (typeof source === "string" || source == null) return source?.trim() ?? "";

  const description = source.description?.trim() ?? "";
  const responsibilities = parseStoredDescriptionList(source.jobResponsibilities);
  const qualifications = parseStoredDescriptionList(source.jobQualifications);
  return [
    description,
    responsibilities.length ? `Responsibilities:\n- ${responsibilities.join("\n- ")}` : "",
    qualifications.length ? `Qualifications:\n- ${qualifications.join("\n- ")}` : "",
  ].filter(Boolean).join("\n\n");
}

export function hasUsableJobDescription(source: MatchDescriptionSource): boolean {
  const normalized = matchJobDescriptionText(source).replace(/\s+/g, " ").trim().toLowerCase();
  return normalized.length >= MIN_MATCH_DESCRIPTION_CHARS
    && !MISSING_DESCRIPTION_VALUES.has(normalized);
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
