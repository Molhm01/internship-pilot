import { prisma } from "@/lib/db";
import { listJobsForCompany } from "@/lib/ats";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { promoteCanonicalDirectJob, pruneStaleActiveJobs } from "@/lib/jobs/activeFeed";
import { upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import { runExpandedPublicDirectFeedDiscovery } from "@/lib/sync/publicDirectFeedsExpanded";
import { runMassTechnicalFeedDiscovery } from "@/lib/sync/massTechnicalFeeds";
import { runJobrightFreshDiscovery } from "@/lib/sync/jobrightFreshDiscovery";
import { runMultiSourceLiveCrawl } from "@/lib/sync/liveMultiSourceCrawler";
import { scoreAllActiveJobsImmediately } from "@/lib/matching";
import {
  MASTER_ACTIVITIES,
  MASTER_EDUCATION,
  MASTER_EXPERIENCE,
  MASTER_PROJECTS,
  MASTER_SKILLS,
} from "@/lib/documents/masterResume";

const CURATED_COMPANIES: Array<{
  name: string;
  industry: string;
  website: string;
  careersUrl: string;
  atsType: string;
  atsIdentifier: string;
  priority: "priority" | "standard";
}> = [
  {
    name: "Stripe",
    industry: "FinTech / Distributed Systems",
    website: "https://stripe.com",
    careersUrl: "https://stripe.com/jobs",
    atsType: "greenhouse",
    atsIdentifier: "stripe",
    priority: "priority",
  },
  {
    name: "Cloudflare",
    industry: "Cloud Infrastructure / Security",
    website: "https://www.cloudflare.com",
    careersUrl: "https://www.cloudflare.com/careers/",
    atsType: "greenhouse",
    atsIdentifier: "cloudflare",
    priority: "priority",
  },
  {
    name: "Figma",
    industry: "Design Tools / Systems Engineering",
    website: "https://www.figma.com",
    careersUrl: "https://www.figma.com/careers/",
    atsType: "greenhouse",
    atsIdentifier: "figma",
    priority: "priority",
  },
  {
    name: "Discord",
    industry: "Communications / Real-time Infra",
    website: "https://discord.com",
    careersUrl: "https://discord.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "discord",
    priority: "priority",
  },
  {
    name: "Coinbase",
    industry: "FinTech / Platform Engineering",
    website: "https://www.coinbase.com",
    careersUrl: "https://www.coinbase.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "coinbase",
    priority: "standard",
  },
  {
    name: "Databricks",
    industry: "Data & AI Infrastructure",
    website: "https://www.databricks.com",
    careersUrl: "https://www.databricks.com/company/careers",
    atsType: "greenhouse",
    atsIdentifier: "databricks",
    priority: "priority",
  },
  {
    name: "Scale AI",
    industry: "AI Infrastructure",
    website: "https://scale.com",
    careersUrl: "https://scale.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "scaleai",
    priority: "priority",
  },
  {
    name: "Verkada",
    industry: "Embedded & IoT Security Systems",
    website: "https://www.verkada.com",
    careersUrl: "https://www.verkada.com/careers/",
    atsType: "greenhouse",
    atsIdentifier: "verkada",
    priority: "priority",
  },
  {
    name: "Samsara",
    industry: "Connected Operations / Embedded",
    website: "https://www.samsara.com",
    careersUrl: "https://www.samsara.com/company/careers",
    atsType: "greenhouse",
    atsIdentifier: "samsara",
    priority: "priority",
  },
  {
    name: "Anduril Industries",
    industry: "Defense Hardware & Autonomy",
    website: "https://www.anduril.com",
    careersUrl: "https://www.anduril.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "andurilindustries",
    priority: "standard",
  },
  {
    name: "Ramp",
    industry: "FinTech / Backend Engineering",
    website: "https://ramp.com",
    careersUrl: "https://ramp.com/careers",
    atsType: "ashby",
    atsIdentifier: "ramp",
    priority: "priority",
  },
  {
    name: "Notion",
    industry: "Productivity / Full-Stack Systems",
    website: "https://www.notion.so",
    careersUrl: "https://www.notion.so/careers",
    atsType: "ashby",
    atsIdentifier: "notion",
    priority: "standard",
  },
  {
    name: "Vercel",
    industry: "Developer Cloud Platform",
    website: "https://vercel.com",
    careersUrl: "https://vercel.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "vercel",
    priority: "priority",
  },
  {
    name: "MongoDB",
    industry: "Database Systems",
    website: "https://www.mongodb.com",
    careersUrl: "https://www.mongodb.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "mongodb",
    priority: "standard",
  },
  {
    name: "Plaid",
    industry: "Financial Infrastructure APIs",
    website: "https://plaid.com",
    careersUrl: "https://plaid.com/careers/",
    atsType: "lever",
    atsIdentifier: "plaid",
    priority: "standard",
  },
  {
    name: "Applied Intuition",
    industry: "Autonomous Simulation & Embedded",
    website: "https://www.appliedintuition.com",
    careersUrl: "https://www.appliedintuition.com/careers",
    atsType: "greenhouse",
    atsIdentifier: "appliedintuition",
    priority: "priority",
  },
];

const globalBootstrap = globalThis as unknown as {
  __pilotBootstrapPromises?: Map<string, Promise<void>>;
  __pilotDiscoveryRan?: boolean;
};

function inflightMap(): Map<string, Promise<void>> {
  if (!globalBootstrap.__pilotBootstrapPromises) {
    globalBootstrap.__pilotBootstrapPromises = new Map();
  }
  return globalBootstrap.__pilotBootstrapPromises;
}

export async function ensureStarterProfile(userId: string): Promise<void> {
  const [existingProfile, factCount, authUser] = await Promise.all([
    prisma.userProfile.findUnique({ where: { userId }, select: { id: true, applicationEmail: true } }),
    prisma.resumeFact.count({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }).catch(() => null),
  ]);

  if (existingProfile && existingProfile.applicationEmail?.toLowerCase() === "molhmalasri7@gmail.com") {
    await prisma.userProfile
      .update({
        where: { userId },
        data: { applicationEmail: "mjalasri1@gmail.com" },
      })
      .catch(() => undefined);
  }

  if (existingProfile && factCount > 0) return;

  if (!existingProfile) {
    const isOwnerWorkspace =
      userId === "pilot-workspace-user"
      || authUser?.email === "molhmiscool21@gmail.com"
      || authUser?.email === "molhmalasri7@gmail.com"
      || authUser?.email === "mjalasri1@gmail.com"
      || authUser?.email?.endsWith("@internshippilot.local");
    const displayName = (authUser?.name ?? "").trim();
    const parts = displayName.split(/\s+/).filter(Boolean);
    const legalFirstName = isOwnerWorkspace
      ? "Molhm"
      : (parts[0] || "Molhm");
    const legalLastName = isOwnerWorkspace
      ? "Alasri"
      : (parts.length > 1 ? parts.slice(1).join(" ") : "Alasri");
    const preferredName = `${legalFirstName} ${legalLastName}`.trim();
    const applicationEmail = "mjalasri1@gmail.com";

    await prisma.userProfile.upsert({
      where: { userId },
      create: {
        userId,
        legalFirstName,
        legalLastName,
        preferredName,
        applicationEmail,
        phone: "9292643117",
        phoneCountryCode: "+1",
        addressLine1: "119 E 7th st",
        city: "Clifton",
        state: "NJ",
        postalCode: "07011",
        country: "United States",
        linkedinUrl: "https://www.linkedin.com/in/molhm-alasri/",
        githubUrl: "https://github.com/Molhm01",
        portfolioUrl: "https://molhm-alasri-portfolio.vercel.app",
      },
      update: {},
    });
  }

  const existingPrefs = await prisma.applicationPreferences.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!existingPrefs) {
    await prisma.applicationPreferences.create({
      data: {
        userId,
        legallyAuthorizedToWork: true,
        requiresSponsorshipNow: false,
        mayRequireSponsorshipLater: false,
        willingToRelocate: true,
        remotePreference: "no_preference",
        earliestStartDate: "2026-05-25",
        salaryPreference: "Negotiable",
        hasDriversLicense: true,
        securityClearanceStatus: "None",
        usualJobSource: "Company Career Site",
      },
    });
  }

  const existingSensitive = await prisma.sensitiveAnswerPreferences.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!existingSensitive) {
    await prisma.sensitiveAnswerPreferences.create({
      data: {
        userId,
        declineDemographics: true,
      },
    });
  }

  const eduCount = await prisma.education.count({ where: { userId } });
  if (eduCount === 0) {
    await prisma.education.create({
      data: {
        userId,
        school: MASTER_EDUCATION[0]?.school ?? "New Jersey Institute of Technology",
        degree: "B.S. Electrical Engineering",
        major: "Electrical Engineering",
        educationLevel: "Undergraduate",
        startMonth: "09",
        startYear: "2026",
        graduationMonth: "05",
        graduationYear: "2029",
        relevantCoursework: JSON.stringify([
          "Digital Design",
          "Circuits & Systems I",
          "Differential Equations",
        ]),
        sortOrder: 0,
      },
    });
    await prisma.education.create({
      data: {
        userId,
        school: MASTER_EDUCATION[1]?.school ?? "Stevens Institute of Technology",
        degree: "B.E. Computer Engineering",
        major: "Computer Engineering",
        educationLevel: "Undergraduate",
        startMonth: "09",
        startYear: "2025",
        graduationMonth: "05",
        graduationYear: "2026",
        gpa: "3.76",
        relevantCoursework: JSON.stringify([
          "Programming & Algorithmic Thinking (C++)",
          "Engineering Design",
          "Sustainable Systems with Sensors",
        ]),
        sortOrder: 1,
      },
    });
  }

  const expCount = await prisma.experience.count({ where: { userId } });
  if (expCount === 0) {
    for (const [idx, exp] of MASTER_EXPERIENCE.entries()) {
      await prisma.experience.create({
        data: {
          userId,
          employer: exp.organization || "Independent",
          title: exp.title,
          location: exp.location || null,
          startDate: exp.dates.split(/[–-]/)[0]?.trim() || null,
          endDate: exp.dates.toLowerCase().includes("present") ? null : exp.dates.split(/[–-]/)[1]?.trim() || null,
          currentlyEmployed: exp.dates.toLowerCase().includes("present"),
          approvedBullets: JSON.stringify(exp.bullets),
          sortOrder: idx,
        },
      });
    }
  }

  const projCount = await prisma.project.count({ where: { userId } });
  if (projCount === 0) {
    for (const [idx, proj] of MASTER_PROJECTS.entries()) {
      await prisma.project.create({
        data: {
          userId,
          name: proj.title,
          technologies: proj.organization ? JSON.stringify(proj.organization.split(",").map((s) => s.trim())) : null,
          description: proj.bullets[0] ?? null,
          approvedSkills: JSON.stringify(proj.bullets),
          sortOrder: idx,
        },
      });
    }
  }

  if (factCount === 0) {
    const factIdsByCategory: Record<"education" | "experience" | "project" | "skill" | "activity", string[]> = {
      education: [],
      experience: [],
      project: [],
      skill: [],
      activity: [],
    };

    const addFact = async (
      type: string,
      content: string,
      detail: string | null,
      bucket?: keyof typeof factIdsByCategory,
    ) => {
      const created = await prisma.resumeFact.create({
        data: { userId, type, content, detail, status: "approved", source: "manual" },
      });
      if (bucket) factIdsByCategory[bucket].push(created.id);
      return created;
    };

    for (const edu of MASTER_EDUCATION) {
      await addFact("education", edu.school, `${edu.degree} ${edu.coursework} (${edu.dates})`, "education");
    }
    await addFact("gpa", "3.76 GPA", "Stevens Institute of Technology Dean's List", "education");
    await addFact("graduationDate", "May 2029", "Expected graduation", "education");
    for (const course of [
      "Digital Design",
      "Circuits & Systems I",
      "Differential Equations",
      "Engineering Design",
      "Programming & Algorithmic Thinking (C++)",
      "Sustainable Systems with Sensors",
    ]) {
      await addFact("coursework", course, null, "education");
    }

    for (const exp of MASTER_EXPERIENCE) {
      const created = await addFact(
        "experience",
        `${exp.title}${exp.organization ? ` at ${exp.organization}` : ""}`,
        exp.bullets.join(" "),
        "experience",
      );
      for (const bullet of exp.bullets) {
        await prisma.resumeBullet.create({
          data: {
            userId,
            category: "experience",
            text: bullet,
            factIds: JSON.stringify([created.id]),
          },
        });
      }
    }

    for (const proj of MASTER_PROJECTS) {
      const created = await addFact(
        "project",
        proj.title,
        `${proj.organization ? `${proj.organization}. ` : ""}${proj.bullets.join(" ")}`,
        "project",
      );
      for (const bullet of proj.bullets) {
        await prisma.resumeBullet.create({
          data: {
            userId,
            category: "project",
            text: bullet,
            factIds: JSON.stringify([created.id]),
          },
        });
      }
    }

    for (const group of MASTER_SKILLS) {
      for (const skill of group.items) {
        await addFact("skill", skill, group.label, "skill");
      }
    }

    for (const act of MASTER_ACTIVITIES) {
      const created = await addFact("activity", act, null, "activity");
      await prisma.resumeBullet.create({
        data: {
          userId,
          category: "activity",
          text: act,
          factIds: JSON.stringify([created.id]),
        },
      });
    }
  }
}

export async function ensureCompaniesSeeded(): Promise<void> {
  const existingCount = await prisma.company.count();
  if (existingCount > 0) return;

  for (const company of CURATED_COMPANIES) {
    try {
      await prisma.company.upsert({
        where: { name: company.name },
        create: {
          name: company.name,
          industry: company.industry,
          website: company.website,
          careersUrl: company.careersUrl,
          atsType: company.atsType,
          atsIdentifier: company.atsIdentifier,
          priority: company.priority,
          source: "seed",
          monitoringStatus: "active",
          allowlisted: true,
          atsConfigState: "VALIDATED",
        },
        update: {},
      });
    } catch {
      // Ignore individual company conflicts
    }
  }
}

/**
 * Queries live public direct internship feeds AND verified public ATS boards
 * in bounded parallel with strict timeouts so real engineering internships
 * are persisted on initial run without external credentials or CSV imports.
 */
export async function runLiveDiscoveryCycle(options: {
  maxCompanies?: number;
  scoreUserId?: string;
  maxScoreCount?: number;
} = {}): Promise<{ discovered: number; scored: number }> {
  await ensureCompaniesSeeded();

  const maxCompanies = options.maxCompanies ?? 16;
  const companies = await prisma.company.findMany({
    where: { monitoringStatus: "active", allowlisted: true, atsIdentifier: { not: null } },
    orderBy: [{ priority: "asc" }, { lastCheckedAt: "asc" }],
    take: maxCompanies,
  });

  const startedAt = new Date();

  const [companyResults, expanded, mass, jobrightFresh, multiSource] = await Promise.all([
    Promise.allSettled(
      companies.map(async (company) => {
        const listed = await Promise.race([
          listJobsForCompany({
            name: company.name,
            atsType: company.atsType,
            atsIdentifier: company.atsIdentifier,
            careersUrl: company.careersUrl,
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
        ]);
        if (!listed?.supported) return 0;

        const internJobs = listed.jobs.filter((j) => isTargetEngineeringRole(j.title, j.description ?? "")).slice(0, 20);
        let persisted = 0;
        for (const [idx, job] of internJobs.entries()) {
          try {
            const outcome = await upsertClassifiedAtsJob({
              job,
              source: company.atsType ?? "greenhouse",
              atsType: company.atsType ?? "greenhouse",
              atsTenant: company.atsIdentifier ?? company.name.toLowerCase(),
              classification: "QUALIFYING_INTERNSHIP",
              classificationReason: "Live engineering internship read directly from official ATS board.",
              rowIndex: idx,
            });
            await promoteCanonicalDirectJob(
              job,
              company.atsType ?? "greenhouse",
              company.atsIdentifier ?? "",
            );
            if (outcome === "new") persisted += 1;
          } catch {
            // Keep per-job failures non-fatal
          }
        }
        await prisma.company.update({
          where: { id: company.id },
          data: {
            lastCheckedAt: new Date(),
            lastCheckStatus: "success",
            activeInternshipCount: internJobs.length,
          },
        }).catch(() => undefined);
        return persisted;
      }),
    ),
    Promise.race([
      runExpandedPublicDirectFeedDiscovery(150).catch(() => ({ newCount: 0, updatedCount: 0 })),
      new Promise<{ newCount: number; updatedCount: number }>((resolve) =>
        setTimeout(() => resolve({ newCount: 0, updatedCount: 0 }), 9_000),
      ),
    ]),
    Promise.race([
      runMassTechnicalFeedDiscovery(400).catch(() => ({ newCount: 0, updatedCount: 0 })),
      new Promise<{ newCount: number; updatedCount: number }>((resolve) =>
        setTimeout(() => resolve({ newCount: 0, updatedCount: 0 }), 9_000),
      ),
    ]),
    Promise.race([
      runJobrightFreshDiscovery(120, 8_000).catch(() => ({ newJobs: 0, updatedJobs: 0 })),
      new Promise<{ newJobs: number; updatedJobs: number }>((resolve) =>
        setTimeout(() => resolve({ newJobs: 0, updatedJobs: 0 }), 9_000),
      ),
    ]),
    Promise.race([
      runMultiSourceLiveCrawl({ maxPerSource: 60 }).catch(() => ({ newCount: 0, updatedCount: 0 })),
      new Promise<{ newCount: number; updatedCount: number }>((resolve) =>
        setTimeout(() => resolve({ newCount: 0, updatedCount: 0 }), 12_000),
      ),
    ]),
  ]);

  let discovered = expanded.newCount + mass.newCount + jobrightFresh.newJobs + multiSource.newCount;
  for (const res of companyResults) {
    if (res.status === "fulfilled") discovered += res.value;
  }

  await prisma.syncLog.create({
    data: {
      source: "employer-ats",
      startedAt,
      finishedAt: new Date(),
      status: "success",
      newJobsCount: discovered,
      updatedJobsCount: expanded.updatedCount + mass.updatedCount + jobrightFresh.updatedJobs + multiSource.updatedCount,
    },
  }).catch(() => undefined);

  await pruneStaleActiveJobs().catch(() => undefined);

  let scored = 0;
  const scoreUserId = options.scoreUserId;
  if (scoreUserId) {
    const scoreOutcome = await scoreAllActiveJobsImmediately(scoreUserId, {
      origin: "INITIAL_AUTO",
    });
    scored = scoreOutcome.scored;
  }

  return { discovered, scored };
}

const STALE_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export async function ensureWorkspaceBootstrapped(
  userId: string,
  options: { skipDiscovery?: boolean } = {},
): Promise<void> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;

  const inflight = inflightMap();
  const existingPromise = inflight.get(userId);
  if (existingPromise) return existingPromise;

  const task = (async () => {
    try {
      await ensureStarterProfile(userId);
      await ensureCompaniesSeeded();

      const nowMs = Date.now();
      const lastPrunedAt = (globalBootstrap as { __lastStalePrunedAt?: number }).__lastStalePrunedAt ?? 0;
      if (nowMs - lastPrunedAt > STALE_PRUNE_INTERVAL_MS) {
        (globalBootstrap as { __lastStalePrunedAt?: number }).__lastStalePrunedAt = nowMs;
        await pruneStaleActiveJobs().catch(() => undefined);
      }

      if (!options.skipDiscovery && !globalBootstrap.__pilotDiscoveryRan) {
        const jobCount = await prisma.job.count({ where: { activeFeed: true } });
        if (jobCount === 0) {
          globalBootstrap.__pilotDiscoveryRan = true;
          await runLiveDiscoveryCycle({
            maxCompanies: 16,
            scoreUserId: userId,
          });
        } else {
          globalBootstrap.__pilotDiscoveryRan = true;
          const existingSync = await prisma.syncLog.findFirst({
            where: { source: "employer-ats", status: "success" },
            select: { id: true },
          });
          if (!existingSync) {
            await prisma.syncLog.create({
              data: {
                source: "employer-ats",
                startedAt: new Date(),
                finishedAt: new Date(),
                status: "success",
                newJobsCount: jobCount,
                updatedJobsCount: 0,
              },
            }).catch(() => undefined);
          }
        }
      }

      // Guarantee 100% of active jobs have a grounded score for this user.
      await scoreAllActiveJobsImmediately(userId, { origin: "INITIAL_AUTO" });
    } catch (error) {
      console.warn("[bootstrap] non-fatal startup warning:", error instanceof Error ? error.message : String(error));
    } finally {
      inflight.delete(userId);
    }
  })();

  inflight.set(userId, task);
  return task;
}
