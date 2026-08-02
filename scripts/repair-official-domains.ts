import "dotenv/config";
import { prisma } from "@/lib/db";

const AGGREGATOR_DOMAINS = [
  "jobright.ai",
  "simplify.jobs",
  "intern-list.com",
  "jobright",
  "simplify",
  "intern-list",
];

async function repairBadOfficialDomains() {
  console.log("=== Repairing Aggregator Domains Ingested as Official Domains ===");

  const badJobs = await prisma.job.findMany({
    where: {
      OR: AGGREGATOR_DOMAINS.map((domain) => ({
        officialEmployerDomain: { contains: domain },
      })),
    },
  });

  console.log(`Found ${badJobs.length} job(s) with aggregator domains saved as officialEmployerDomain.`);

  let repairedCount = 0;
  for (const job of badJobs) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        officialEmployerDomain: null,
      },
    });
    repairedCount += 1;
    console.log(`  [Repaired] Job "${job.title}" at "${job.company}" (cleared bad official domain "${job.officialEmployerDomain}")`);
  }

  // Also ensure all trusted aggregator jobs have activeFeed = true
  const inactiveTrustedJobs = await prisma.job.findMany({
    where: {
      activeFeed: false,
      source: { in: ["jobright", "jobright.ai", "simplify", "intern-list", "intern-list.com"] },
      verificationStatus: { notIn: ["SecurityQuarantine", "Closed", "DESTINATION_MISMATCH"] },
    },
  });

  let activatedCount = 0;
  for (const job of inactiveTrustedJobs) {
    await prisma.job.update({
      where: { id: job.id },
      data: { activeFeed: true },
    });
    activatedCount += 1;
  }

  console.log(`\n=== Domain Repair Complete ===`);
  console.log(`Official domain records repaired: ${repairedCount}`);
  console.log(`Jobs activated for main feed: ${activatedCount}`);
}

void repairBadOfficialDomains();
