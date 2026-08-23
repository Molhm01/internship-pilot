import { prisma } from "@/lib/db";
import type { RawInternListJob } from "@/lib/sync/internListAdapter";
import type { AtsJob } from "@/lib/ats/types";
import {
  classifyCitizenshipOrClearance,
  classifyDisciplines,
  classifyGraduationYears,
  classifySeason,
  classifySophomoreEligible,
  classifySponsorship,
  distanceFromCliftonMiles,
  parseCompensation,
} from "@/lib/sync/classify";
import { computeActiveFeed, isDirectOfficialSource } from "@/lib/jobs/sourcePolicy";
import {
  destinationPersistenceData,
  isAggregatorUrl,
  resolveOfficialJobDestination,
} from "@/lib/applications/officialDestination";
import { scheduleInitialAiMatchForAllUsers } from "@/lib/matching/initialAiMatchQueue";
import type { InternshipClassification } from "@/lib/sync/internshipClassifier";
import {
  employerAtsProvenance,
  parseFirstSourceDate,
  shouldReplaceCanonicalSourceDate,
  trustedRadarProvenance,
  type ParsedSourceDate,
  type SourceDateProvenance,
} from "@/lib/sync/sourceDate";

// Normalize a title for fallback dedup.
//
// This deliberately does NOT strip "intern"/"internship". The previous
// version did, which collapsed "Software Engineer Intern" and "Software
// Engineer" at the same company+location onto one key and silently merged an
// internship into an unrelated full-time role. The internship token is the
// most load-bearing word in the title for this product — it must survive
// normalization.
export function normalizeForFallbackKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// Locations differ cosmetically far more often than they differ materially
// ("New York, NY" / "new york ny "). Normalize punctuation and case so that
// genuinely different cities stay distinct while formatting drift does not
// manufacture duplicates.
export function normalizeLocationKey(location: string | null | undefined): string {
  return (location ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tracking parameters to drop, listed EXPLICITLY rather than by prefix.
//
// A prefix rule is dangerous here: an earlier `gh_` prefix also matched
// `gh_jid`, which is Greenhouse's JOB IDENTIFIER on boards that point at a
// employer-hosted careers page (e.g.
// "https://waymo.com/careers/?gh_jid=12345"). Stripping it collapsed every
// posting on such a board to one URL — 392 distinct Waymo jobs became one.
// Anything not named here is preserved, so an unknown-but-meaningful
// parameter can never silently merge two postings.
const TRACKING_PARAMS =
  /^(utm_[a-z]+|gh_src|lever-source|lever-origin|lever-via|ref|source|src|fbclid|gclid|msclkid|mc_cid|mc_eid|trk|trackingid|_ga)$/i;

// Strip tracking parameters so the same posting reached through different
// campaign links resolves to one canonical URL rather than N duplicates.
export function canonicalizeJobUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    url.protocol = "https:";
    // Trailing slashes are not semantically meaningful for these boards.
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw.trim() || null;
  }
}

function formatInternshipTerm(hireTime: string | null): string | null {
  if (!hireTime) return null;
  // jobright format is "2027-Summer" / "2026-Winter/Spring" / bare "Summer"
  const match = hireTime.match(/^(\d{4})-(.+)$/);
  if (match) return `${match[2]} ${match[1]}`;
  return hireTime;
}

type NormalizedJobInput = {
  source: string;
  sourceJobId: string;
  requisitionId: string | null;
  title: string;
  company: string;
  location: string | null;
  postedAt: Date | null;
  /**
   * Canonical source posting date for this row. When absent it is derived from
   * `postedAt`/`postedAtText` against `sourceCapturedAt`.
   */
  sourceDate?: ParsedSourceDate;
  sourceDateProvenance?: SourceDateProvenance;
  /** When the source was READ. Relative dates resolve against this instant. */
  sourceCapturedAt?: Date;
  /** Identity of the sync run that produced this row, and its position in it. */
  sourceSyncRunId?: string | null;
  sourceRowIndex?: number | null;
  internshipTerm: string | null;
  description: string;
  sourceUrl: string | null;
  sourceListingUrl?: string | null;
  officialApplicationUrl?: string | null;
  originalJobPostUrl?: string | null;
  workplaceType: string | null;
  compensation: string | null;
  sponsorshipRaw: string | null; // raw h1bSponsored-style text, or null if unknown
  classification?: InternshipClassification | null;
  classificationReason?: string | null;
  atsType?: string | null;
  atsTenant?: string | null;
};

// How a newly created job should describe its own provenance.
//
// A posting read straight off an employer's own Greenhouse/Lever/Ashby board
// API is the strongest provenance the product has: the URL IS the employer's
// official application page, obtained from the employer's own system. That is
// materially different from an aggregator listing that merely claims a job
// exists, so it is recorded as verified rather than pending.
type VerificationProfile = {
  verificationStatus: string;
  reasonCode: string;
  verificationReason: string;
  verificationMethod: string | null;
};

const AGGREGATOR_PROFILE: VerificationProfile = {
  verificationStatus: "Pending",
  reasonCode: "SOURCE_LISTED",
  verificationReason: "Listed on the discovery source; official destination verification is queued.",
  verificationMethod: null,
};

export function directAtsProfile(atsType: string): VerificationProfile {
  return {
    verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
    reasonCode: "OFFICIAL_ATS_BOARD",
    verificationReason: `Read directly from the employer's official ${atsType} job board API.`,
    verificationMethod: `${atsType}-board-api`,
  };
}

// Identity resolution, most-specific key first. Every tier requires the
// posting to be the SAME posting — never merely a similar-looking one — so
// that the same title in two cities, two requisition IDs, or two seasonal
// postings all stay separate records.
async function findExistingJob(input: NormalizedJobInput) {
  // Tier 1: the source's own stable job id. Authoritative.
  const bySourceId = await prisma.job.findFirst({
    where: { source: input.source, sourceJobId: input.sourceJobId },
  });
  if (bySourceId) return bySourceId;

  // Tier 2: employer-assigned requisition id, scoped to the employer.
  if (input.requisitionId) {
    const byRequisition = await prisma.job.findFirst({
      where: { company: input.company, requisitionId: input.requisitionId },
    });
    if (byRequisition) return byRequisition;
  }

  // Tier 3: the canonical official application URL. Two links that differ
  // only by tracking parameters point at one posting.
  const canonicalUrl = canonicalizeJobUrl(input.officialApplicationUrl ?? input.sourceUrl);
  if (canonicalUrl) {
    const sameCompany = await prisma.job.findMany({
      where: { company: { equals: input.company } },
      select: { id: true, officialApplicationUrl: true, sourceUrl: true, url: true },
    });
    const urlHit = sameCompany.find((c) =>
      [c.officialApplicationUrl, c.sourceUrl, c.url]
        .map(canonicalizeJobUrl)
        .some((u) => u !== null && u === canonicalUrl),
    );
    if (urlHit) return prisma.job.findUnique({ where: { id: urlHit.id } });
  }

  // Tier 4 (last resort): same company + exact normalized title + normalized
  // location + same requisition identity. Scoped to one source so a listing
  // discovered independently through two sources is not force-merged; the
  // title keeps its "intern" token, so an internship can never collapse into
  // the full-time role of the same name.
  const normalizedTitle = normalizeForFallbackKey(input.title);
  const normalizedLocation = normalizeLocationKey(input.location);
  const candidates = await prisma.job.findMany({
    where: { company: { equals: input.company }, source: input.source },
  });
  return (
    candidates.find(
      (c) =>
        normalizeForFallbackKey(c.title) === normalizedTitle &&
        normalizeLocationKey(c.location) === normalizedLocation &&
        (c.requisitionId ?? null) === (input.requisitionId ?? null),
    ) ?? null
  );
}

export type IngestSummary = { newCount: number; updatedCount: number };

async function upsertNormalizedJob(
  input: NormalizedJobInput,
  now: Date,
  profile: VerificationProfile = AGGREGATOR_PROFILE,
): Promise<"new" | "updated" | "unchanged"> {
  const existing = await findExistingJob(input);
  const company = await prisma.company.findFirst({
    where: { name: { equals: input.company } },
    select: { careersUrl: true },
  });
  const destination = await resolveOfficialJobDestination(
    {
      // A direct-ATS read arrives already officially sourced: its applyUrl IS
      // the employer's application page. Passing the profile status lets the
      // resolver short-circuit instead of making a redundant network request
      // per posting (thousands of them across a full sync).
      verificationStatus: existing?.verificationStatus ?? profile.verificationStatus,
      resolutionStatus: existing?.resolutionStatus,
      sourceListingUrl:
        input.sourceListingUrl
        ?? existing?.sourceListingUrl
        ?? (isAggregatorUrl(input.sourceUrl) ? input.sourceUrl : null),
      officialApplicationUrl:
        input.officialApplicationUrl
        ?? existing?.officialApplicationUrl
        ?? (!isAggregatorUrl(input.sourceUrl) ? input.sourceUrl : null),
      originalJobPostUrl: input.originalJobPostUrl ?? existing?.originalJobPostUrl,
      sourceUrl: input.sourceUrl ?? existing?.sourceUrl,
      officialApplyUrl: existing?.officialApplyUrl,
      officialJobUrl: existing?.officialJobUrl,
      url: existing?.url,
      employerCareerUrl: company?.careersUrl,
    },
    fetch,
    now,
    { followSourceListings: false },
  );
  const destinationData = destinationPersistenceData(destination);

  const capturedAt = input.sourceCapturedAt ?? now;
  const sourceDate = input.sourceDate ?? parseFirstSourceDate([input.postedAt], capturedAt);
  const sourceDateProvenance =
    input.sourceDateProvenance
    ?? (profile.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK"
      ? employerAtsProvenance(sourceDate)
      : trustedRadarProvenance(sourceDate));
  // Sync context is refreshed on EVERY sighting: the row-order fallback must
  // describe where the job sits in the newest sync, not an old one.
  const sourceSyncContext = {
    sourceCapturedAt: capturedAt,
    ...(input.sourceSyncRunId !== undefined ? { sourceSyncRunId: input.sourceSyncRunId } : {}),
    ...(input.sourceRowIndex !== undefined ? { sourceRowIndex: input.sourceRowIndex } : {}),
  };

  if (existing) {
    const descriptionChanged = Boolean(input.description) && existing.description !== input.description;
    const canonicalPromotion =
      profile.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK"
      && (
        existing.source !== input.source
        || existing.verificationStatus !== profile.verificationStatus
        || existing.atsType !== input.atsType
        || existing.atsTenant !== input.atsTenant
        || existing.closedAt !== null
      );
    const changed =
      canonicalPromotion ||
      descriptionChanged ||
      existing.title !== input.title ||
      (input.location !== null && existing.location !== input.location) ||
      (input.workplaceType !== null && existing.workplaceType !== input.workplaceType) ||
      (input.requisitionId !== null && existing.requisitionId !== input.requisitionId) ||
      existing.sourceUrl !== input.sourceUrl ||
      existing.officialApplicationUrl !== destination.officialApplicationUrl ||
      existing.resolutionStatus !== destination.resolutionStatus;
    // Rediscovery must never make an old posting look new. The posting date is
    // written once and only replaced when THIS sighting carries a strictly more
    // reliable date (e.g. an exact timestamp replacing a parsed "3 days ago").
    const replacePostedAt = shouldReplaceCanonicalSourceDate(
      {
        sourcePostedAt: existing.sourcePostedAt ?? null,
        sourceDateConfidence: existing.sourceDateConfidence ?? null,
        sourceDateProvenance:
          existing.sourceDateProvenance
          ?? (existing.source
            ? (isDirectOfficialSource(existing.source)
              ? employerAtsProvenance({
                  sourcePostedAt: existing.sourcePostedAt,
                  sourcePostedText: existing.sourcePostedText,
                  sourceDateConfidence: (existing.sourceDateConfidence ?? "UNKNOWN") as ParsedSourceDate["sourceDateConfidence"],
                })
              : trustedRadarProvenance({
                  sourcePostedAt: existing.sourcePostedAt,
                  sourcePostedText: existing.sourcePostedText,
                  sourceDateConfidence: (existing.sourceDateConfidence ?? "UNKNOWN") as ParsedSourceDate["sourceDateConfidence"],
                }))
            : sourceDateProvenance),
      },
      sourceDate,
      sourceDateProvenance,
    );
    await prisma.job.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: now,
        ...sourceSyncContext,
        ...(replacePostedAt
          ? {
              sourcePostedAt: sourceDate.sourcePostedAt,
              sourcePostedText: sourceDate.sourcePostedText,
              sourceDateConfidence: sourceDate.sourceDateConfidence,
              sourceDateProvenance,
            }
          : {}),
        ...destinationData,
        ...(changed
          ? {
              description: input.description || existing.description,
              title: input.title,
              location: input.location ?? existing.location,
              workplaceType: input.workplaceType ?? existing.workplaceType,
              requisitionId: input.requisitionId ?? existing.requisitionId,
              sourceUrl: input.sourceUrl ?? existing.sourceUrl,
              ...(descriptionChanged && existing.description
                ? { scoringState: "STALE", scoringError: null }
                : {}),
            }
          : {}),
        ...(canonicalPromotion
          ? {
              source: input.source,
              sourceJobId: input.sourceJobId,
              requisitionId: input.requisitionId ?? existing.requisitionId,
              verificationStatus: profile.verificationStatus,
              reasonCode: profile.reasonCode,
              verificationReason: profile.verificationReason,
              verificationMethod: profile.verificationMethod,
              lastVerifiedAt: now,
              atsType: input.atsType ?? existing.atsType,
              atsTenant: input.atsTenant ?? existing.atsTenant,
              activeFeed: true,
              consecutiveBoardMisses: 0,
              boardMissingSince: null,
              closedAt: null,
            }
          : {}),
        // Refresh classification on rediscovery so a classifier improvement
        // reaches existing rows without a separate backfill.
        ...(input.classification
          ? {
              classification: input.classification,
              classificationReason: input.classificationReason ?? null,
            }
          : {}),
      },
    });
    return changed ? "updated" : "unchanged";
  }

  const disciplineTags = classifyDisciplines(input.title, input.description);
  const { min: compMinHourly, max: compMaxHourly } = parseCompensation(input.compensation);

  const created = await prisma.job.create({
    data: {
      title: input.title,
      company: input.company,
      location: input.location,
      postingDate: sourceDate.sourcePostedAt ?? input.postedAt,
      sourcePostedAt: sourceDate.sourcePostedAt,
      sourcePostedText: sourceDate.sourcePostedText,
      sourceDateConfidence: sourceDate.sourceDateConfidence,
      sourceDateProvenance,
      ...sourceSyncContext,
      internshipTerm: input.internshipTerm,
      description: input.description,
      status: "DISCOVERED",
      source: input.source,
      sourceJobId: input.sourceJobId,
      requisitionId: input.requisitionId,
      sourceUrl: input.sourceUrl,
      ...destinationData,
      workplaceType: input.workplaceType,
      firstSeenAt: now,
      lastSeenAt: now,
      compensation: input.compensation && input.compensation.toUpperCase() !== "N/A" ? input.compensation : null,
      // Provenance comes from the caller's profile. Aggregator listings stay
      // "Pending" (an ACTIVE state) so they remain visible while queued for
      // verification; direct-ATS reads are already officially sourced.
      verificationStatus: profile.verificationStatus,
      reasonCode: profile.reasonCode,
      verificationReason: profile.verificationReason,
      ...(profile.verificationMethod ? { verificationMethod: profile.verificationMethod } : {}),
      ...(profile.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK" ? { lastVerifiedAt: now } : {}),
      atsType: input.atsType ?? null,
      atsTenant: input.atsTenant ?? null,
      classification: input.classification ?? null,
      classificationReason: input.classificationReason ?? null,
      // Visibility is decided centrally by source policy. Never by whether an
      // AI score or a tailored document exists.
      activeFeed: computeActiveFeed({
        source: input.source,
        verificationStatus: profile.verificationStatus,
        company: input.company,
      }),
      disciplineTags: JSON.stringify(disciplineTags),
      sophomoreEligible: classifySophomoreEligible(input.description),
      graduationYears: JSON.stringify(classifyGraduationYears(input.description)),
      sponsorship: classifySponsorship(input.sponsorshipRaw),
      citizenshipOrClearance: classifyCitizenshipOrClearance(input.description),
      compMinHourly,
      compMaxHourly,
      season: classifySeason(input.internshipTerm),
      distanceMilesFromClifton: distanceFromCliftonMiles(input.location),
    },
  });
  try {
    await scheduleInitialAiMatchForAllUsers(created.id);
  } catch (error) {
    // Scheduling is a short database operation, never a model request. A
    // temporary queue-write failure must not roll back successful ingestion.
    console.error("[ingest] initial AI Match scheduling failed", {
      jobId: created.id,
      errorCode: error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "SCHEDULE_FAILED",
    });
  }
  return "new";
}

async function isEmployerAllowlisted(companyName: string): Promise<boolean> {
  const target = companyName.trim().toLowerCase();
  // Case-insensitive compare against the allowlisted set — small enough
  // (hundreds of rows) that an in-memory compare is simpler and just as
  // fast as a raw SQL LOWER() query here.
  const allowlisted = await prisma.company.findMany({ where: { allowlisted: true }, select: { name: true } });
  return allowlisted.some((c) => c.name.trim().toLowerCase() === target);
}

async function recordNewEmployerReview(input: {
  employerName: string;
  jobTitle: string;
  jobUrl: string | null;
}): Promise<void> {
  let guessedDomain: string | null = null;
  try {
    if (input.jobUrl) guessedDomain = new URL(input.jobUrl).hostname;
  } catch {
    guessedDomain = null;
  }
  await prisma.newEmployerReview.upsert({
    where: { employerName: input.employerName },
    update: { sourceJobTitle: input.jobTitle, sourceJobUrl: input.jobUrl },
    create: {
      employerName: input.employerName,
      discoveredFrom: "intern-list",
      guessedDomain,
      sourceJobTitle: input.jobTitle,
      sourceJobUrl: input.jobUrl,
    },
  });
}

// Intern List ingestion (Phase 2), now gated by the strict discovery
// boundary (per the source-security requirements): a job is only ingested
// as a trackable Job if its employer is already allowlisted (CSV, manual,
// or a previously-approved Intern-List employer). Anything else is placed
// in NEW_EMPLOYER_REVIEW instead — never auto-ingested, never applied to,
// until the user approves the employer's official domain once.
export async function ingestJobs(
  rawJobs: RawInternListJob[],
  context: { syncRunId?: string | null; capturedAt?: Date } = {},
): Promise<IngestSummary> {
  let newCount = 0;
  let updatedCount = 0;
  const now = new Date();
  const capturedAt = context.capturedAt ?? now;

  for (const raw of rawJobs) {
    const allowlisted = await isEmployerAllowlisted(raw.company);
    if (!allowlisted) {
      await recordNewEmployerReview({ employerName: raw.company, jobTitle: raw.title, jobUrl: raw.applyUrl });
      continue;
    }

    const result = await upsertNormalizedJob(
      {
        source: "intern-list",
        sourceJobId: raw.sourceJobId,
        requisitionId: null,
        title: raw.title,
        company: raw.company,
        location: raw.location,
        postedAt: raw.postedAt,
        // The adapter already resolved the date against the capture time and
        // tagged its confidence. A caller that predates those fields (older
        // fixtures/scripts) still gets a correct value derived from postedAt.
        sourceDate: raw.sourceDateConfidence
          ? {
              sourcePostedAt: raw.sourcePostedAt,
              sourcePostedText: raw.sourcePostedText,
              sourceDateConfidence: raw.sourceDateConfidence,
            }
          : parseFirstSourceDate([raw.sourcePostedAt ?? raw.postedAt], capturedAt),
        sourceDateProvenance: trustedRadarProvenance(
          raw.sourceDateConfidence
            ? {
                sourcePostedAt: raw.sourcePostedAt,
                sourcePostedText: raw.sourcePostedText,
                sourceDateConfidence: raw.sourceDateConfidence,
              }
            : parseFirstSourceDate([raw.sourcePostedAt ?? raw.postedAt], capturedAt),
        ),
        sourceCapturedAt: capturedAt,
        sourceSyncRunId: context.syncRunId ?? null,
        sourceRowIndex: raw.sourceRowIndex ?? null,
        internshipTerm: formatInternshipTerm(raw.hireTime),
        description: raw.qualifications || "",
        sourceUrl: raw.applyUrl,
        sourceListingUrl: raw.sourceListingUrl ?? raw.applyUrl,
        officialApplicationUrl: raw.officialApplicationUrl,
        originalJobPostUrl: raw.originalJobPostUrl,
        workplaceType: raw.workModel,
        compensation: raw.salary,
        sponsorshipRaw: raw.h1bSponsored,
      },
      now,
    );
    if (result === "new") newCount++;
    else if (result === "updated") updatedCount++;
  }

  return { newCount, updatedCount };
}

// Milestone 1: ingestion for any ATS-sourced job (Greenhouse/Lever/Ashby/
// SmartRecruiters/Workday/USAJOBS/generic-scan), tagged with the given
// source name so verification/quarantine logic can treat "generic scan"
// results with appropriately lower trust.
export async function ingestAtsJobs(
  jobs: AtsJob[],
  source: string,
  context: { syncRunId?: string | null; capturedAt?: Date } = {},
): Promise<IngestSummary> {
  let newCount = 0;
  let updatedCount = 0;
  const now = new Date();
  const capturedAt = context.capturedAt ?? now;
  const genericDateProvenance: SourceDateProvenance = /(?:^|:)spa$/i.test(source)
    ? "EMPLOYER_JSON_LD"
    : "INFERRED";

  for (const [sourceRowIndex, job] of jobs.entries()) {
    const result = await upsertNormalizedJob(
      {
        source,
        sourceJobId: job.sourceJobId,
        requisitionId: job.requisitionId ?? null,
        title: job.title,
        company: job.company,
        location: job.location,
        postedAt: job.postedAt,
        sourceDate: parseFirstSourceDate([job.postedAt, job.postedAtText], capturedAt),
        sourceDateProvenance: genericDateProvenance,
        sourceCapturedAt: capturedAt,
        sourceSyncRunId: context.syncRunId ?? null,
        sourceRowIndex,
        internshipTerm: null,
        description: job.description,
        sourceUrl: job.applyUrl,
        sourceListingUrl: null,
        officialApplicationUrl: job.applyUrl,
        workplaceType: job.workplaceType,
        compensation: null,
        sponsorshipRaw: null,
      },
      now,
    );
    if (result === "new") newCount++;
    else if (result === "updated") updatedCount++;
  }

  return { newCount, updatedCount };
}

/**
 * Persist ONE classified job read directly from an employer's official ATS
 * board. Deliberately single-record and independently awaited: the caller
 * wraps each call in its own try/catch so a malformed posting can never
 * abort a multi-thousand-record run, and no run-wide transaction exists to
 * roll back work that already succeeded.
 */
export async function upsertClassifiedAtsJob(args: {
  job: AtsJob;
  source: string;
  atsType: string;
  atsTenant: string;
  classification: InternshipClassification;
  classificationReason: string;
  now?: Date;
  syncRunId?: string | null;
  rowIndex?: number | null;
  capturedAt?: Date;
  sourceDateProvenance?: SourceDateProvenance;
}): Promise<"new" | "updated" | "unchanged"> {
  const capturedAt = args.capturedAt ?? args.now ?? new Date();
  const sourceDate = parseFirstSourceDate([args.job.postedAt, args.job.postedAtText], capturedAt);
  return upsertNormalizedJob(
    {
      source: args.source,
      sourceJobId: args.job.sourceJobId,
      requisitionId: args.job.requisitionId ?? null,
      title: args.job.title,
      company: args.job.company,
      location: args.job.location,
      postedAt: args.job.postedAt,
      sourceDate,
      sourceDateProvenance: args.sourceDateProvenance ?? employerAtsProvenance(sourceDate),
      sourceCapturedAt: capturedAt,
      sourceSyncRunId: args.syncRunId ?? null,
      sourceRowIndex: args.rowIndex ?? null,
      internshipTerm: null,
      description: args.job.description,
      // For a direct ATS read these are the same URL, and it is the
      // employer's own application page — not an aggregator listing.
      sourceUrl: args.job.applyUrl,
      sourceListingUrl: null,
      officialApplicationUrl: args.job.applyUrl,
      workplaceType: args.job.workplaceType,
      compensation: null,
      sponsorshipRaw: null,
      classification: args.classification,
      classificationReason: args.classificationReason,
      atsType: args.atsType,
      atsTenant: args.atsTenant,
    },
    args.now ?? new Date(),
    directAtsProfile(args.atsType),
  );
}
