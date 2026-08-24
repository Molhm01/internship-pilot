import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { TRACKER_STATUSES } from "@/lib/statuses";
import { computeActiveFeed } from "@/lib/jobs/sourcePolicy";
import type { Prisma } from "@/generated/prisma/client";
import {
  destinationPersistenceData,
  resolveOfficialJobDestination,
} from "@/lib/applications/officialDestination";
import { scheduleInitialAiMatchForAllUsers } from "@/lib/matching/initialAiMatchQueue";
import { withUser } from "@/lib/auth/session";
import { jobOrderBy, parseJobSort } from "@/lib/jobs/jobSort";
import { jobsQueryErrorDevDetail, jobsQueryErrorLog } from "@/lib/jobs/jobsQueryError";
import { parseSourcePostedAt } from "@/lib/sync/sourceDate";
import { manualEntryVerification } from "@/lib/jobs/manualEntry";
import {
  discoverFreshnessLabel,
  KNOWN_POSTED_FRESH_WINDOW_MS,
  UNKNOWN_DATE_DISCOVERED_WINDOW_MS,
} from "@/lib/jobs/freshness";
import {
  baselineStateData,
  calculateBaselineScore,
  loadApprovedBaselineProfile,
  loadAllApprovedBaselineProfiles,
  backfillBaselineScoresForUser,
} from "@/lib/matching/baselineScoring";

const DEFAULT_JOBS_PAGE_SIZE = 50;
const MAX_JOBS_PAGE_SIZE = 100;
const PROFILE_NOT_READY_MESSAGE = "Complete your profile to activate job matching.";

function parseListParam(value: string | null): string[] {
  return value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

/**
 * Projects one user's state onto a shared job row.
 *
 * The feed's shape is unchanged — `status`, `matchScore` and
 * `eligibilityStatus` are still top-level fields on each job — but they are now
 * read from this user's `UserJobState` rather than from the shared columns of
 * the same name. Every reader of the API therefore keeps working, and none of
 * them can see anybody else's tracker state.
 *
 * A job with no state row for this user is simply undecided: DISCOVERED, no
 * score. That is the correct answer for a posting they have never looked at.
 */
function withUserState<T extends { userStates?: unknown[] }>(job: T) {
  const state = (job.userStates ?? [])[0] as
    | {
        applicationStatus: string;
        saved: boolean;
        hidden: boolean;
        notes: string | null;
        matchScore: number | null;
        eligibilityStatus: string | null;
        scoreSource: string | null;
        scoreProfileRevision: string | null;
        scoreJobFingerprint: string | null;
      }
    | undefined;
  const rest = { ...(job as T & { userStates?: unknown[] }) };
  delete rest.userStates;
  return {
    ...rest,
    status: state?.applicationStatus ?? "DISCOVERED",
    matchScore: state?.matchScore ?? null,
    eligibilityStatus: state?.eligibilityStatus ?? null,
    scoreSource: state?.scoreSource ?? null,
    scoreProfileRevision: state?.scoreProfileRevision ?? null,
    scoreJobFingerprint: state?.scoreJobFingerprint ?? null,
    saved: state?.saved ?? false,
    hidden: state?.hidden ?? false,
    notes: state?.notes ?? null,
  };
}

async function getJobsResponse(req: Request, userId: string) {
  const { searchParams } = new URL(req.url);
  const profile = await loadApprovedBaselineProfile(userId);
  const allActiveTotal = await prisma.job.count({ where: { activeFeed: true } });
  if (!profile) {
    return NextResponse.json(
      {
        jobs: [],
        total: 0,
        allActiveTotal,
        offset: 0,
        returned: 0,
        nextOffset: null,
        hasMore: false,
        sort: parseJobSort(searchParams.get("sort")),
        view: (searchParams.get("view") ?? "fresh").toLowerCase(),
        profileReady: false,
        scoreReadinessMessage: PROFILE_NOT_READY_MESSAGE,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const missingCurrentScores = await prisma.job.count({
    where: {
      activeFeed: true,
      OR: [
        { userStates: { none: { userId } } },
        { userStates: { some: { userId, matchScore: null } } },
        { userStates: { some: { userId, scoreProfileRevision: null } } },
        { userStates: { some: { userId, scoreProfileRevision: { not: profile.revision } } } },
      ],
    },
  });
  if (missingCurrentScores > 0) await backfillBaselineScoresForUser(userId);
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
  const requestedView = (searchParams.get("view") ?? "fresh").toLowerCase();
  const view = requestedView === "all" || requestedView === "older" ? requestedView : "fresh";
  // newest (default) | oldest | match | discovered. Anything unrecognized falls
  // back to newest rather than erroring — a bad link must not break the feed.
  const sort = parseJobSort(searchParams.get("sort"));

  const where: Prisma.JobWhereInput = {};
  const andFilters: Prisma.JobWhereInput[] = [];
  // Case-insensitive by request. SQLite's LIKE ignored ASCII case for free;
  // PostgreSQL's does not, and a filter for "remote" that stops matching
  // "Remote" reads as a broken feed rather than a changed database.
  if (location) where.location = { contains: location, mode: "insensitive" };
  // Tracker status is this user's, so the filter is a constraint on their
  // state row rather than on the shared job.
  if (status) where.userStates = { some: { userId, applicationStatus: status } };
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
  if (matchScoreMin) {
    where.userStates = {
      some: {
        ...(status ? { applicationStatus: status } : {}),
        userId,
        matchScore: { gte: parseInt(matchScoreMin, 10) },
      },
    };
  }
  // Visibility is enforced centrally here (single place, not per-component):
  //  - An explicit verificationStatus filter still works (used by tooling).
  //  - Otherwise feed=active (default) shows Active-feed jobs, feed=needsReview
  //    shows the rest that aren't officially verified, feed=all shows all.
  if (verificationStatus.length > 0) {
    where.verificationStatus = { in: verificationStatus };
  }
  if (feed === "active") {
    where.activeFeed = true;
  } else if (feed === "needsreview" || feed === "needs-review") {
    where.activeFeed = false;
    where.verificationStatus = { not: "VERIFIED_OFFICIAL_AT_LAST_CHECK" };
  }
  // feed === "all": no visibility constraint.

  if (feed === "active") {
    const now = Date.now();
    if (view === "fresh") {
      andFilters.push({
        OR: [
          { sourcePostedAt: { gte: new Date(now - KNOWN_POSTED_FRESH_WINDOW_MS), lte: new Date(now) } },
          {
            sourcePostedAt: null,
            firstSeenAt: { gte: new Date(now - UNKNOWN_DATE_DISCOVERED_WINDOW_MS), lte: new Date(now) },
          },
        ],
      });
    } else if (view === "older") {
      where.sourcePostedAt = {
        gt: new Date(now - 30 * 24 * 60 * 60 * 1000),
        lt: new Date(now - 7 * 24 * 60 * 60 * 1000),
      };
    }
  }

  if (maxDistanceMiles) {
    const max = parseFloat(maxDistanceMiles);
    andFilters.push({
      OR: [
        { distanceMilesFromClifton: { lte: max } },
        ...(includeRemoteRegardlessOfDistance ? [{ workplaceType: "Remote" as const }] : []),
      ],
    });
  }
  if (disciplines.length > 0) {
    andFilters.push({
      OR: disciplines.map((discipline) => ({
        disciplineTags: { contains: `"${discipline}"` },
      })),
    });
  }
  if (graduationYear) {
    andFilters.push({
      OR: [
        { graduationYears: null },
        { graduationYears: "[]" },
        { graduationYears: { contains: String(parseInt(graduationYear, 10)) } },
      ],
    });
  }
  if (andFilters.length > 0) where.AND = andFilters;

  // Newest SOURCE POSTING first — never newest row-insert first. Ordering is
  // by Job.sourcePostedAt so a bulk import of month-old postings cannot jump
  // ahead of an internship posted an hour ago (see JOB_FRESHNESS_SORT_AUDIT.md).
  // Scoring, verification and official-URL state are badges, never sort keys.
  // The default feed still never drops jobs for lacking an AI match score,
  // official verification, or an ATS mirror — visibility is governed solely by
  // activeFeed above.
  const offsetParam = parseInt(searchParams.get("offset") ?? "0", 10);
  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;
  const requestedLimit = parseInt(searchParams.get("limit") ?? String(DEFAULT_JOBS_PAGE_SIZE), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_JOBS_PAGE_SIZE, requestedLimit))
    : DEFAULT_JOBS_PAGE_SIZE;
  let jobs;
  if (sort === "match") {
    const states = await prisma.userJobState.findMany({
      where: { userId, job: where, matchScore: { gte: 0, lte: 100 } },
      orderBy: [
        { matchScore: { sort: "desc", nulls: "last" } },
        { job: { sourcePostedAt: { sort: "desc", nulls: "last" } } },
        { jobId: "desc" },
      ],
      skip: offset,
      take: limit,
      include: {
        job: {
          include: {
            matchResults: { where: { userId }, orderBy: { createdAt: "desc" }, take: 1 },
          },
        },
      },
    });
    jobs = states.map((stateRow) => {
      const { job, ...state } = stateRow;
      return withUserState({ ...job, userStates: [state] });
    });
  } else {
    const rows = await prisma.job.findMany({
      where,
      orderBy: jobOrderBy(sort),
      skip: offset,
      take: limit,
      include: {
        matchResults: { where: { userId }, orderBy: { createdAt: "desc" }, take: 1 },
        userStates: { where: { userId }, take: 1 },
      },
    });
    jobs = rows.map(withUserState);
  }

  // Fields stored as JSON strings are filtered in-memory — the dataset here
  // is small (a personal job board, not a production job search engine).
  // JSON-backed filters were translated into SQL above, before pagination.

  // Final ordering is applied here, over the full filtered set and BEFORE
  // pagination, so every page of the feed is a slice of one consistent order.
  // Two rules cannot be expressed in a single SQL ORDER BY and are enforced
  // here instead: unknown posting dates always sort last, and sourceRowIndex
  // only breaks ties among jobs from the newest sync run.
  // Database ordering is stable and is applied before skip/take.

  // Pagination: `total` is the full matching count so the UI can page/scroll
  // to EVERY record. Absent limit ⇒ return everything (no hidden hard cap).
  // A direct database/editor change can bypass ingestion hooks. Validate this
  // bounded page against the full JD fingerprint before serialization so a
  // stale AI score becomes a baseline, never a stale personalized result.
  if (feed === "active") {
    const refreshed = new Map<string, ReturnType<typeof baselineStateData>>();
    const writes = jobs.flatMap((job) => {
      const baseline = calculateBaselineScore(profile, job);
      if (job.scoreJobFingerprint === baseline.jobFingerprint) return [];
      const data = baselineStateData(baseline);
      refreshed.set(job.id, data);
      return prisma.userJobState.upsert({
        where: { userId_jobId: { userId, jobId: job.id } },
        create: { userId, jobId: job.id, ...data },
        update: data,
      });
    });
    if (writes.length > 0) {
      await prisma.$transaction(writes);
      jobs = jobs.map((job) => {
        const data = refreshed.get(job.id);
        return data ? { ...job, ...data } : job;
      });
    }
  }
  jobs = jobs.map((job) => ({
    ...job,
    freshnessLabel: discoverFreshnessLabel(job),
  }));

  const total = await prisma.job.count({ where });
  if (feed === "active" && jobs.some((job) => !Number.isInteger(job.matchScore))) {
    throw new Error("ACTIVE_JOB_SCORE_INVARIANT_VIOLATION");
  }
  const nextOffset = offset + jobs.length < total ? offset + jobs.length : null;

  return NextResponse.json(
    {
      jobs,
      total,
      allActiveTotal,
      offset,
      returned: jobs.length,
      nextOffset,
      hasMore: nextOffset !== null,
      limit,
      sort,
      view,
      profileReady: true,
      scoreReadinessMessage: null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export const GET = withUser(async (req, user) => {
  try {
    return await getJobsResponse(req, user.id);
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
});

/**
 * Adds a job by hand.
 *
 * The Job row itself is canonical and shared — a posting somebody pasted in is
 * still a real posting, and the discovery pipeline treats it like any other.
 * What is personal is the tracker status that came with it, which goes to this
 * user's own state row.
 */
export const POST = withUser(async (req, user) => {
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
  // The trust decision and its exact wording are policy, so they come from
  // src/lib/jobs/manualEntry.ts rather than being written out here.
  const manualVerification = manualEntryVerification({
    resolutionStatus: destination.resolutionStatus,
    officialApplicationUrl: destination.officialApplicationUrl ?? null,
    enteredAt: now,
  });
  const activeFeed = computeActiveFeed({
    source: "manual",
    verificationStatus: manualVerification.verificationStatus,
    company: company.trim(),
  });
  const profiles = activeFeed ? await loadAllApprovedBaselineProfiles() : [];
  const scoringInput = {
    title: title.trim(),
    company: company.trim(),
    location: body.location?.trim() || null,
    internshipTerm: body.internshipTerm?.trim() || null,
    description: description.trim(),
  };
  const initialStates: Prisma.UserJobStateUncheckedCreateWithoutJobInput[] = profiles.map((candidate) => ({
    userId: candidate.userId,
    ...(candidate.userId === user.id ? { applicationStatus: body.status || "DISCOVERED" } : {}),
    ...baselineStateData(calculateBaselineScore(candidate, scoringInput)),
  }));
  if (!profiles.some((candidate) => candidate.userId === user.id)) {
    initialStates.push({
      userId: user.id,
      applicationStatus: body.status || "DISCOVERED",
    });
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
      // Manually entered jobs are trusted by construction — the user pasted
      // them in themselves, so there's nothing to independently verify.
      ...manualVerification,
      evidence: JSON.stringify({ manualEntry: true, enteredAt: now.toISOString() }),
      firstSeenAt: now,
      lastSeenAt: now,
      lastVerifiedAt: now,
      source: "manual",
      // Manually-entered jobs are trusted by construction, so they belong in
      // the Active feed (unless the company reads as a demo/fixture).
      activeFeed,
      userStates: {
        create: initialStates,
      },
    },
  });

  try {
    await scheduleInitialAiMatchForAllUsers(job.id, { startWorker: false });
  } catch (error) {
    console.error("[api/jobs] initial AI Match scheduling failed", {
      jobId: job.id,
      errorCode: error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "SCHEDULE_FAILED",
    });
  }

  return NextResponse.json({ job }, { status: 201 });
});
