import "dotenv/config";
import { prisma } from "@/lib/db";

const DAY_MS = 24 * 60 * 60 * 1_000;

type Provider =
  | "Workday"
  | "SuccessFactors"
  | "Greenhouse"
  | "Lever"
  | "Ashby"
  | "iCIMS"
  | "Custom/API"
  | "Other";

function providerFor(source: string | null, atsType: string | null): Provider {
  const value = (atsType ?? source ?? "").toLowerCase();
  if (value === "workday") return "Workday";
  if (value === "successfactors") return "SuccessFactors";
  if (value === "greenhouse") return "Greenhouse";
  if (value === "lever") return "Lever";
  if (value === "ashby") return "Ashby";
  if (value === "icims") return "iCIMS";
  if (["custom", "api", "smartrecruiters", "eightfold", "phenom", "usajobs"].includes(value)) {
    return "Custom/API";
  }
  return "Other";
}

function within(value: Date | null, now: Date, days: number): boolean {
  return Boolean(value && value <= now && now.getTime() - value.getTime() <= days * DAY_MS);
}

async function main() {
  const now = new Date();
  const [jobs, eligibleUsers, radar] = await Promise.all([
    prisma.job.findMany({
      where: { activeFeed: true },
      select: { id: true, source: true, atsType: true, sourcePostedAt: true, firstSeenAt: true },
    }),
    prisma.user.findMany({
      where: { resumeFacts: { some: { status: { in: ["approved", "edited"] } } } },
      orderBy: { id: "asc" },
      select: { id: true },
    }),
    prisma.freshSignalResolution.findMany({
      where: { state: "RESOLVED" },
      select: { sourceCapturedAt: true, sourcePostedAt: true },
    }),
  ]);

  const posted = {
    under24h: jobs.filter((job) => within(job.sourcePostedAt, now, 1)).length,
    under72h: jobs.filter((job) => within(job.sourcePostedAt, now, 3)).length,
    within7d: jobs.filter((job) => within(job.sourcePostedAt, now, 7)).length,
    days8to14: jobs.filter((job) => job.sourcePostedAt
      && now.getTime() - job.sourcePostedAt.getTime() > 7 * DAY_MS
      && now.getTime() - job.sourcePostedAt.getTime() <= 14 * DAY_MS).length,
    days15to30: jobs.filter((job) => job.sourcePostedAt
      && now.getTime() - job.sourcePostedAt.getTime() > 14 * DAY_MS
      && now.getTime() - job.sourcePostedAt.getTime() <= 30 * DAY_MS).length,
    over30d: jobs.filter((job) => job.sourcePostedAt
      && now.getTime() - job.sourcePostedAt.getTime() > 30 * DAY_MS).length,
    unknown: jobs.filter((job) => !job.sourcePostedAt).length,
  };
  const newlyDiscoveredUnknownDate = jobs.filter((job) =>
    !job.sourcePostedAt && within(job.firstSeenAt, now, 3),
  ).length;

  const providers = [
    "Workday", "SuccessFactors", "Greenhouse", "Lever", "Ashby", "iCIMS", "Custom/API", "Other",
  ] as const;
  const providerResults = Object.fromEntries(providers.map((provider) => {
    const rows = jobs.filter((job) => providerFor(job.source, job.atsType) === provider);
    return [provider, {
      active: rows.length,
      postedUnder24h: rows.filter((job) => within(job.sourcePostedAt, now, 1)).length,
      postedUnder72h: rows.filter((job) => within(job.sourcePostedAt, now, 3)).length,
      postedWithin7d: rows.filter((job) => within(job.sourcePostedAt, now, 7)).length,
      discoveredUnder24h: rows.filter((job) => within(job.firstSeenAt, now, 1)).length,
      discoveredUnder72h: rows.filter((job) => within(job.firstSeenAt, now, 3)).length,
      discoveredWithin7d: rows.filter((job) => within(job.firstSeenAt, now, 7)).length,
    }];
  }));

  const scoreCoverage = [];
  for (const user of eligibleUsers) {
    const [scored, baseline, aiRefined] = await Promise.all([
      prisma.job.count({
        where: { activeFeed: true, userStates: { some: { userId: user.id, matchScore: { gte: 0, lte: 100 } } } },
      }),
      prisma.job.count({ where: { activeFeed: true, userStates: { some: { userId: user.id, scoreSource: "BASELINE" } } } }),
      prisma.job.count({ where: { activeFeed: true, userStates: { some: { userId: user.id, scoreSource: "AI_REFINED" } } } }),
    ]);
    scoreCoverage.push({
      userId: user.id,
      active: jobs.length,
      scored,
      unscored: jobs.length - scored,
      coveragePercent: jobs.length === 0 ? 100 : Number((100 * scored / jobs.length).toFixed(2)),
      baseline,
      aiRefined,
    });
  }

  console.log(JSON.stringify({
    generatedAt: now.toISOString(),
    active: jobs.length,
    posted,
    defaultDiscoverCount: posted.within7d + newlyDiscoveredUnknownDate,
    defaultDiscoverComponents: {
      knownRecent: posted.within7d,
      newlyDiscoveredUnknownDate,
    },
    allActiveCount: jobs.length,
    eligibleUserCount: eligibleUsers.length,
    scoreCoverage,
    providers: providerResults,
    radarResolved: {
      total: radar.length,
      capturedUnder24h: radar.filter((row) => within(row.sourceCapturedAt, now, 1)).length,
      capturedUnder72h: radar.filter((row) => within(row.sourceCapturedAt, now, 3)).length,
      capturedWithin7d: radar.filter((row) => within(row.sourceCapturedAt, now, 7)).length,
      postedWithin7d: radar.filter((row) => within(row.sourcePostedAt, now, 7)).length,
    },
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
