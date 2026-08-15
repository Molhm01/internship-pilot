import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { TRACKER_STATUSES } from "@/lib/statuses";
import { computeActiveFeed } from "@/lib/jobs/sourcePolicy";
import type { Prisma } from "@/generated/prisma/client";
import {
  destinationPersistenceData,
  resolveOfficialJobDestination,
} from "@/lib/applications/officialDestination";
import { scheduleInitialAiMatch } from "@/lib/matching/initialAiMatchQueue";
import { jobOrderBy, parseJobSort, sortJobs } from "@/lib/jobs/jobSort";
import { jobsQueryErrorDevDetail, jobsQueryErrorLog } from "@/lib/jobs/jobsQueryError";
import { parseSourcePostedAt } from "@/lib/sync/sourceDate";

function parseListParam(value: string | null): string[] {
  return value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

async function getJobsResponse(req: Request) {
  const { searchParams } = new URL(req.url);
  const location = searchParams.get("location");
  const status = searchParams.get("status");
  const internshipTerm = searchParams.get("internshipTerm");
  const duration = searchParams.get("duration");
  const postingDateFrom = searchParams.get("postingDateFrom");
  const postingDateTo = searchParams.get("postingDateTo");
  const lastVerifiedFrom = searchParams.get("lastVerifiedFrom");
  const lastVerifiedTo = searchParams.get("lastVerifiedTo");
  const workplaceType = searchParams.get("workplaceType");
  const season = searchParams.get("season");
  const maxDistanceMiles = searchParams.get("maxDistanceMiles");
  const includeRemoteRegardlessOfDistance = searchParams.get("includeRemoteRegardlessOfDistance") === "true";
  const disciplines = parseListParam(searchParams.get("disciplines"));
  const sophomoreEligible = searchParams.get("sophomoreEligible"); // "true" | "false" | null
  const graduationYear = searchParams.get("graduationYear");
  const sponsorship = searchParams.get("sponsorship");
  const citizenshipOrClearance = searchParams.get("citizenshipOrClearance"); // "true" | "false" | null
  const compMin = searchParams.get("compMin");
  const matchScoreMin = searchParams.get("matchScoreMin");
  const verificationStatus = parseListParam(searchParams.get("verificationStatus"));
  // feed=active (default) | needsReview | all. Visibility is decided by the
  // central Active-feed policy (computeActiveFeed) stored on Job.activeFeed —
  // NOT by verificationStatus. Trusted-aggregator listings appear here even
  // while their official destination is still "verification pending".
  const feed = (searchParams.get("feed") ?? "active").toLowerCase();
  // newest (default) | oldest | match | discovered. Anything unrecognized falls
  // back to newest rather than erroring — a bad link must not break the feed.
  const sort = parseJobSort(searchParams.get("sort"));

  const where: Prisma.JobWhereInput = {};
  // Case-insensitive by request. SQLite's LIKE ignored ASCII case for free;
  // PostgreSQL's does not, and a filter for "remote" that stops matching
  // "Remote" reads as a broken feed rather than a changed database.
  if (location) where.location = { contains: location, mode: "insensitive" };
  if (status) where.status = status;
  if (internshipTerm) where.internshipTerm = { contains: internshipTerm, mode: "insensitive" };
  if (duration) where.duration = { contains: duration, mode: "insensitive" };
  if (postingDateFrom || postingDateTo) {
    where.postingDate = {
      ...(postingDateFrom ? { gte: new Date(postingDateFrom) } : {}),
      ...(postingDateTo ? { lte: new Date(postingDateTo) } : {}),
    };
  }
  if (lastVerifiedFrom || lastVerifiedTo) {
    where.lastVerifiedAt = {
      ...(lastVerifiedFrom ? { gte: new Date(lastVerifiedFrom) } : {}),
      ...(lastVerifiedTo ? { lte: new Date(lastVerifiedTo) } : {}),
    };
  }
  if (workplaceType) where.workplaceType = workplaceType;
  if (season) where.season = season;
  if (sophomoreEligible === "true") where.sophomoreEligible = true;
  if (sophomoreEligible === "false") where.sophomoreEligible = false;
  if (sponsorship) where.sponsorship = sponsorship;
  if (citizenshipOrClearance === "true") where.citizenshipOrClearance = true;
  if (citizenshipOrClearance === "false") where.citizenshipOrClearance = false;
  if (compMin) where.compMaxHourly = { gte: parseFloat(compMin) };
  if (matchScoreMin) where.matchScore = { gte: parseInt(matchScoreMin, 10) };
  // Visibility is enforced centrally here (single place, not per-component):
  //  - An explicit verificationStatus filter still works (used by tooling).
  //  - Otherwise feed=active (default) shows Active-feed jobs, feed=needsReview
  //    shows the rest that aren't officially verified, feed=all shows all.
  if (verificationStatus.length > 0) {
    where.verificationStatus = { in: verificationStatus };
  } else if (feed === "active") {
    where.activeFeed = true;
  } else if (feed === "needsreview" || feed === "needs-review") {
    where.activeFeed = false;
    where.verificationStatus = { not: "VERIFIED_OFFICIAL_AT_LAST_CHECK" };
  }
  // feed === "all": no visibility constraint.

  if (maxDistanceMiles) {
    const max = parseFloat(maxDistanceMiles);
    where.OR = [
      { distanceMilesFromClifton: { lte: max } },
      ...(includeRemoteRegardlessOfDistance ? [{ workplaceType: "Remote" as const }] : []),
    ];
  }

  // Newest SOURCE POSTING first — never newest row-insert first. Ordering is
  // by Job.sourcePostedAt so a bulk import of month-old postings cannot jump
  // ahead of an internship posted an hour ago (see JOB_FRESHNESS_SORT_AUDIT.md).
  // Scoring, verification and official-URL state are badges, never sort keys.
  // The default feed still never drops jobs for lacking an AI match score,
  // official verification, or an ATS mirror — visibility is governed solely by
  // activeFeed above.
  let jobs = await prisma.job.findMany({
    where,
    orderBy: jobOrderBy(sort),
    include: {
      matchResults: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  // Fields stored as JSON strings are filtered in-memory — the dataset here
  // is small (a personal job board, not a production job search engine).
  if (disciplines.length > 0) {
    jobs = jobs.filter((job) => {
      const tags: string[] = job.disciplineTags ? JSON.parse(job.disciplineTags) : [];
      return disciplines.some((d) => tags.includes(d));
    });
  }
  if (graduationYear) {
    const year = parseInt(graduationYear, 10);
    jobs = jobs.filter((job) => {
      const years: number[] = job.graduationYears ? JSON.parse(job.graduationYears) : [];
      return years.length === 0 || years.includes(year);
    });
  }

  // Final ordering is applied here, over the full filtered set and BEFORE
  // pagination, so every page of the feed is a slice of one consistent order.
  // Two rules cannot be expressed in a single SQL ORDER BY and are enforced
  // here instead: unknown posting dates always sort last, and sourceRowIndex
  // only breaks ties among jobs from the newest sync run.
  jobs = sortJobs(jobs, sort);

  // Pagination: `total` is the full matching count so the UI can page/scroll
  // to EVERY record. Absent limit ⇒ return everything (no hidden hard cap).
  const total = jobs.length;
  const offsetParam = parseInt(searchParams.get("offset") ?? "0", 10);
  const limitParam = searchParams.get("limit");
  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;
  const paged = limitParam ? jobs.slice(offset, offset + Math.max(0, parseInt(limitParam, 10))) : jobs.slice(offset);

  return NextResponse.json(
    { jobs: paged, total, offset, returned: paged.length, sort },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function GET(req: Request) {
  try {
    return await getJobsResponse(req);
  } catch (error) {
    // The exact ORM error, classified and redacted (no connection string, no
    // credential, no description or profile text) — see jobsQueryError.ts.
    console.error(
      "[api/jobs] jobs query failed",
      jobsQueryErrorLog(error, {
        requestPath: new URL(req.url).pathname,
        // The applied sort is the one input that decides which ORM fields the
        // query touches, so it is the one input worth logging. It is a closed
        // set of literals, never free text.
        sort: parseJobSort(new URL(req.url).searchParams.get("sort")),
      }),
    );
    return NextResponse.json(
      {
        error: "The stored jobs could not be loaded because the database query failed.",
        code: "JOBS_QUERY_FAILED",
        dev: jobsQueryErrorDevDetail(error),
      },
      {
        status: 500,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const { title, company, description } = body;
  if (!title?.trim() || !company?.trim() || !description?.trim()) {
    return NextResponse.json(
      { error: "title, company, and description are required" },
      { status: 400 },
    );
  }

  if (body.status && !TRACKER_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
  }

  const now = new Date();
  const manualPostedAt = parseSourcePostedAt(body.postingDate ?? null, now);
  const url: string | null = body.url?.trim() || null;
  const destination = await resolveOfficialJobDestination(
    {
      sourceListingUrl: body.sourceListingUrl?.trim() || url,
      officialApplicationUrl: body.officialApplicationUrl?.trim() || url,
      originalJobPostUrl: body.originalJobPostUrl?.trim() || null,
      sourceUrl: body.sourceListingUrl?.trim() || url,
      officialApplyUrl: url,
      url,
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
    },
    fetch,
    now,
  );
  const destinationData = destinationPersistenceData(destination);
  let officialEmployerDomain: string | null = null;
  if (destination.officialApplicationUrl) {
    try {
      officialEmployerDomain = new URL(destination.officialApplicationUrl).hostname;
    } catch {
      officialEmployerDomain = null;
    }
  }

  const job = await prisma.job.create({
    data: {
      title: title.trim(),
      company: company.trim(),
      description: description.trim(),
      location: body.location?.trim() || null,
      internshipTerm: body.internshipTerm?.trim() || null,
      duration: body.duration?.trim() || null,
      ...destinationData,
      sourceUrl: destination.sourceListingUrl,
      postingDate: manualPostedAt.sourcePostedAt,
      // A manually entered job carries the user's own posting date. A date
      // picker gives a day, not an instant, so it is recorded as DATE_ONLY and
      // never outranks a posting with a real timestamp from the same day.
      sourcePostedAt: manualPostedAt.sourcePostedAt,
      sourcePostedText: manualPostedAt.sourcePostedText,
      sourceDateConfidence: manualPostedAt.sourceDateConfidence,
      sourceCapturedAt: now,
      status: body.status || "DISCOVERED",
      // Manually entered jobs are trusted by construction — the user pasted
      // them in themselves, so there's nothing to independently verify.
      verificationStatus:
        destination.resolutionStatus === "RESOLVED"
          ? "VERIFIED_OFFICIAL_AT_LAST_CHECK"
          : "NeedsReview",
      reasonCode:
        destination.resolutionStatus === "RESOLVED"
          ? "MANUAL_ENTRY"
          : "OFFICIAL_DESTINATION_UNRESOLVED",
      verificationReason:
        destination.resolutionStatus === "RESOLVED"
          ? `Verified on the official employer application page at ${now.toLocaleString()}. (Manually entered by the user — not independently re-checked.)`
          : "The manually entered URL is not a job-specific employer or ATS application page.",
      verificationMethod: "manual-entry",
      officialEmployerDomain,
      evidence: JSON.stringify({ manualEntry: true, enteredAt: now.toISOString() }),
      firstSeenAt: now,
      lastSeenAt: now,
      lastVerifiedAt: now,
      source: "manual",
      // Manually-entered jobs are trusted by construction, so they belong in
      // the Active feed (unless the company reads as a demo/fixture).
      activeFeed: computeActiveFeed({
        source: "manual",
        verificationStatus:
          destination.resolutionStatus === "RESOLVED"
            ? "VERIFIED_OFFICIAL_AT_LAST_CHECK"
            : "NeedsReview",
        company: company.trim(),
      }),
    },
  });

  try {
    await scheduleInitialAiMatch(job.id);
  } catch (error) {
    console.error("[api/jobs] initial AI Match scheduling failed", {
      jobId: job.id,
      errorCode: error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "SCHEDULE_FAILED",
    });
  }

  return NextResponse.json({ job }, { status: 201 });
}
