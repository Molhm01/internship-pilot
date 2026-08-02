export type ManualMatchResult = {
  score: number;
  eligibility: "PASS" | "BORDERLINE" | "FAIL";
  reasoning: string;
  matchingQualifications: string[];
  missingQualifications: string[];
  skillsToLearn: string[];
  neverClaim: string[];
};

export type ImmediateMatchDisplay = {
  id: string;
  eligibility: "Pass" | "Unknown" | "Fail";
  eligibilityReason: string;
  score: number;
  explanation: string;
  recommendation: null;
  skillsSupported: string;
  skillsNeedConfirmation: string;
  skillsToLearn: string;
  skillsNeverAdd: string;
  tailoringPreview: null;
  createdAt: string;
};

export const MANUAL_MATCH_TIMEOUT_MS = 60_000;

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
  constructor(message: string, public readonly code = "MATCH_FAILED") {
    super(message);
    this.name = "MatchRequestError";
  }
}

function sanitizedMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const sanitized = value
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return sanitized || fallback;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function manualMatchToImmediateDisplay(
  result: ManualMatchResult,
  createdAt = new Date(),
): ImmediateMatchDisplay {
  const item = (skill: string, reason: string) => ({ skill, reason, factIds: [] as string[] });
  return {
    id: `completed-${createdAt.getTime()}`,
    eligibility: result.eligibility === "PASS" ? "Pass" : result.eligibility === "FAIL" ? "Fail" : "Unknown",
    eligibilityReason: result.reasoning,
    score: result.score,
    explanation: "Validated against approved profile evidence; unsupported qualifications are listed separately.",
    recommendation: null,
    skillsSupported: JSON.stringify(result.matchingQualifications.map((skill) =>
      item(skill, "Supported by validated approved-profile evidence."),
    )),
    skillsNeedConfirmation: JSON.stringify(result.missingQualifications.map((skill) =>
      item(skill, "Missing or not directly confirmed by approved profile evidence."),
    )),
    skillsToLearn: JSON.stringify(result.skillsToLearn.map((skill) =>
      item(skill, "Classified as a development gap by the validated match."),
    )),
    skillsNeverAdd: JSON.stringify(result.neverClaim.map((skill) =>
      item(skill, "Not supported by approved profile evidence; never represent it as a candidate fact."),
    )),
    tailoringPreview: null,
    createdAt: createdAt.toISOString(),
  };
}

export async function requestManualMatch(
  jobId: string,
  fetcher: typeof fetch = fetch,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ManualMatchResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? MANUAL_MATCH_TIMEOUT_MS;
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new MatchRequestError(
          "AI Match timed out. The button is ready to retry and the previous result was kept.",
          "MATCH_TIMEOUT",
        ));
      }, timeoutMs);
    });
    const response = await Promise.race([
      fetcher("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
        signal: controller.signal,
      }),
      timeout,
    ]);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MatchRequestError(
        response.ok
          ? "AI Match completed without returning a readable result."
          : "AI Match failed without returning a readable error.",
        "MATCH_RESPONSE_UNREADABLE",
      );
    }

    const data = payload && typeof payload === "object"
      ? payload as { ok?: unknown; error?: unknown; message?: unknown; match?: unknown }
      : {};

    if (!response.ok || data.ok !== true) {
      throw new MatchRequestError(
        sanitizedMessage(data.message, "Could not run AI Match."),
        typeof data.error === "string" ? data.error : "MATCH_FAILED",
      );
    }

    const result = data.match;
    if (!result || typeof result !== "object") {
      throw new MatchRequestError("AI Match completed without returning a valid result.", "MATCH_RESPONSE_INVALID");
    }
    const match = result as Partial<ManualMatchResult>;
    if (
      !Number.isInteger(match.score)
      || (match.score ?? -1) < 0
      || (match.score ?? 101) > 100
      || !["PASS", "BORDERLINE", "FAIL"].includes(match.eligibility ?? "")
      || typeof match.reasoning !== "string"
      || !match.reasoning.trim()
      || !isStringArray(match.matchingQualifications)
      || !isStringArray(match.missingQualifications)
      || !isStringArray(match.skillsToLearn)
      || !isStringArray(match.neverClaim)
    ) {
      throw new MatchRequestError("AI Match completed without returning a valid result.", "MATCH_RESPONSE_INVALID");
    }
    return match as ManualMatchResult;
  } catch (error) {
    if (timedOut) {
      throw new MatchRequestError(
        "AI Match timed out. The button is ready to retry and the previous result was kept.",
        "MATCH_TIMEOUT",
      );
    }
    if (error instanceof MatchRequestError) throw error;
    if (controller.signal.aborted) {
      throw new MatchRequestError("AI Match was canceled. The button is ready to retry.", "MATCH_CANCELED");
    }
    throw new MatchRequestError(
      sanitizedMessage(error instanceof Error ? error.message : error, "Could not run AI Match."),
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", abortFromCaller);
    if (process.env.NODE_ENV === "development") {
      console.info(JSON.stringify({
        event: "job-page-timing",
        operation: "ai-match-fetch",
        jobId,
        durationMs: Math.round(performance.now() - startedAt),
      }));
    }
  }
}

export async function runManualMatchAndRefresh(options: {
  jobId: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLoadingChange: (jobId: string, loading: boolean) => void;
  onResult?: (jobId: string, result: ManualMatchResult) => void;
  refreshMatch: (jobId: string) => Promise<void>;
  onRefreshError?: (jobId: string, error: unknown) => void;
}): Promise<ManualMatchResult> {
  options.onLoadingChange(options.jobId, true);
  let result: ManualMatchResult;
  try {
    result = await requestManualMatch(options.jobId, options.fetcher, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    options.onResult?.(options.jobId, result);
  } finally {
    options.onLoadingChange(options.jobId, false);
  }
  void options.refreshMatch(options.jobId).catch((error) => {
    options.onRefreshError?.(options.jobId, error);
  });
  return result;
}
