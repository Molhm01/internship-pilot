import { NextResponse } from "next/server";
import { MatchError, runMatchForJob } from "@/lib/matching";
import { withUser } from "@/lib/auth/session";

type PublicMatch = {
  eligibility: "PASS" | "BORDERLINE" | "FAIL";
  score: number;
  reasoning: string;
  matchingQualifications: string[];
  missingQualifications: string[];
  skillsToLearn: string[];
  neverClaim: string[];
};

function progress(jobId: string, stage: string, details: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ event: "ai-match", jobId, stage, ...details }));
}

function safeMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function safeErrorCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "MATCH_FAILED";
}

function skillNames(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.map((item) => {
      if (!item || typeof item !== "object" || typeof (item as { skill?: unknown }).skill !== "string") {
        throw new Error("invalid qualification");
      }
      return (item as { skill: string }).skill;
    });
  } catch {
    throw new MatchError(
      "The saved AI Match result could not be read safely.",
      500,
      "MATCH_RESPONSE_INVALID",
    );
  }
}

function publicMatch(matchResult: {
  eligibility: string;
  eligibilityReason: string;
  score: number;
  explanation: string;
  skillsSupported: string;
  skillsNeedConfirmation: string;
  skillsToLearn: string;
  skillsNeverAdd: string;
}): PublicMatch {
  if (!Number.isInteger(matchResult.score) || matchResult.score < 0 || matchResult.score > 100) {
    throw new MatchError("The saved AI Match score was invalid.", 500, "MATCH_RESPONSE_INVALID");
  }
  const eligibility = matchResult.eligibility === "Pass"
    ? "PASS"
    : matchResult.eligibility === "Fail"
      ? "FAIL"
      : "BORDERLINE";
  return {
    eligibility,
    score: matchResult.score,
    reasoning: `${matchResult.eligibilityReason} ${matchResult.explanation}`.trim(),
    matchingQualifications: skillNames(matchResult.skillsSupported),
    missingQualifications: skillNames(matchResult.skillsNeedConfirmation),
    skillsToLearn: skillNames(matchResult.skillsToLearn),
    neverClaim: skillNames(matchResult.skillsNeverAdd),
  };
}

/**
 * Runs AI Match for the signed-in user against one job.
 *
 * The job id comes from the request; the person it is scored for never does.
 * Two users asking for the same job get two results, each written against
 * their own résumé facts and their own UserJobState.
 */
export const POST = withUser(async (req, user) => {
  const body = await req.json().catch(() => null);
  const jobId = typeof body?.jobId === "string" && body.jobId.trim()
    ? body.jobId.trim()
    : undefined;

  if (!jobId) {
    return NextResponse.json({
      ok: false,
      error: "INVALID_REQUEST",
      message: "A single job ID is required to run AI Match manually.",
    }, { status: 400 });
  }

  progress(jobId, "request_received");
  try {
    const matchResult = await runMatchForJob(jobId, { userId: user.id, origin: "MANUAL" });
    const match = publicMatch(matchResult);
    progress(jobId, "response_returned", { ok: true });
    return NextResponse.json({ ok: true, match });
  } catch (error) {
    if (error instanceof MatchError) {
      progress(jobId, "response_returned", { ok: false, error: safeErrorCode(error.code) });
      return NextResponse.json({
        ok: false,
        error: safeErrorCode(error.code),
        message: safeMessage(error.message),
      }, { status: error.status });
    }
    progress(jobId, "response_returned", { ok: false, error: "MATCH_FAILED" });
    return NextResponse.json(
      {
        ok: false,
        error: "MATCH_FAILED",
        message: "AI Match failed unexpectedly. The previous result is still available.",
      },
      { status: 500 },
    );
  }
});
