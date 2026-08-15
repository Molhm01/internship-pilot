import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { TRACKER_STATUSES } from "@/lib/statuses";
import { parseSourcePostedAt } from "@/lib/sync/sourceDate";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/**
 * One job, as this user sees it.
 *
 * The posting is shared and returned to anyone signed in. The two things layered
 * on top — the latest AI match and the tracker status — are read from this
 * user's own rows, so the same URL shows two people two different scores over
 * the same canonical description.
 */
export const GET = withUser<Params>(async (_req, user, { params }) => {
  const { id } = await params;
  const startedAt = performance.now();
  const row = await prisma.job.findUnique({
    where: { id },
    include: {
      matchResults: { where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 1 },
      userStates: { where: { userId: user.id }, take: 1 },
    },
  });
  if (process.env.NODE_ENV === "development") {
    console.info(JSON.stringify({
      event: "job-page-db-timing",
      operation: "job-with-latest-match",
      jobId: id,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  }
  if (!row) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const { userStates, ...job } = row;
  // A job this user has never touched has no state row, which is the normal
  // case for most of the catalogue rather than an error.
  const state = (userStates ?? [])[0];
  return NextResponse.json({
    job: {
      ...job,
      status: state?.applicationStatus ?? "DISCOVERED",
      matchScore: state?.matchScore ?? null,
      eligibilityStatus: state?.eligibilityStatus ?? null,
      saved: state?.saved ?? false,
      hidden: state?.hidden ?? false,
      notes: state?.notes ?? null,
    },
  });
});

/**
 * Editing a job.
 *
 * Two different writes live here and they go to two different rows. Corrections
 * to the posting — title, company, dates, URL — are edits to shared canonical
 * data. The tracker status is not: it is this user's decision about their own
 * application, and it goes to their state row. Sending `status` used to change
 * what every other user saw.
 */
export const PATCH = withUser<Params>(async (req, user, { params }) => {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const data: Record<string, unknown> = {};
  for (const field of ["title", "company", "location", "internshipTerm", "duration", "url", "description"] as const) {
    if (typeof body[field] === "string") data[field] = body[field].trim() || null;
  }
  if (body.postingDate !== undefined) {
    // An explicit user edit is the one case where the canonical posting date is
    // deliberately overwritten — the user is a more reliable source than the
    // aggregator. Keep both fields in step so the feed reflects the correction.
    const edited = parseSourcePostedAt(body.postingDate || null, new Date());
    data.postingDate = edited.sourcePostedAt;
    data.sourcePostedAt = edited.sourcePostedAt;
    data.sourcePostedText = edited.sourcePostedText;
    data.sourceDateConfidence = edited.sourceDateConfidence;
  }
  let applicationStatus: string | null = null;
  if (typeof body.status === "string") {
    if (!TRACKER_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
    }
    applicationStatus = body.status;
  }

  try {
    const job =
      Object.keys(data).length > 0
        ? await prisma.job.update({ where: { id }, data })
        : await prisma.job.findUniqueOrThrow({ where: { id } });

    let state = null;
    if (applicationStatus) {
      state = await prisma.userJobState.upsert({
        where: { userId_jobId: { userId: user.id, jobId: id } },
        create: { userId: user.id, jobId: id, applicationStatus },
        update: { applicationStatus },
      });
    }
    return NextResponse.json({
      job: { ...job, ...(state ? { status: state.applicationStatus } : {}) },
    });
  } catch {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
});

/**
 * Removing a job from YOUR feed.
 *
 * It does not delete the canonical posting. A Job row is shared discovery data
 * — other users can see it, the scheduler re-verifies it, and one person's
 * "not interested" is not grounds for destroying it for everybody. Hiding is
 * per user, and it is what this endpoint has always meant from the user's side.
 */
export const DELETE = withUser<Params>(async (_req, user, { params }) => {
  const { id } = await params;
  const job = await prisma.job.findUnique({ where: { id }, select: { id: true } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  await prisma.userJobState.upsert({
    where: { userId_jobId: { userId: user.id, jobId: id } },
    create: { userId: user.id, jobId: id, hidden: true },
    update: { hidden: true },
  });
  return NextResponse.json({ ok: true, hidden: true });
});
