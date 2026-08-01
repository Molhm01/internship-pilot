import { NextResponse } from "next/server";
import { MatchError, runMatchForJob } from "@/lib/matching";
import { queueJobsForMatching } from "@/lib/matching/scoringQueue";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const jobId = typeof body?.jobId === "string" ? body.jobId : undefined;
  const allUnscored = Boolean(body?.allUnscored);
  const rescoreStale = Boolean(body?.rescoreStale);

  if (!jobId && !allUnscored && !rescoreStale) {
    return NextResponse.json({ error: "jobId, allUnscored, or rescoreStale is required" }, { status: 400 });
  }

  try {
    // A person clicking "Run AI Match" needs the completed, persisted result
    // in this response. The durable queue remains for bulk/background scoring,
    // but returning only its acknowledgement made the detail page reload before
    // any MatchResult existed.
    if (jobId) {
      const matchResult = await runMatchForJob(jobId);
      return NextResponse.json({ matchResult });
    }

    const result = await queueJobsForMatching({ allUnscored, rescoreStale });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MatchError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not run AI Match." },
      { status: 500 },
    );
  }
}
