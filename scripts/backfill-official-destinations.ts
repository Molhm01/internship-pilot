import "dotenv/config";
import { prisma } from "@/lib/db";
import {
  destinationPersistenceData,
  resolveOfficialJobDestination,
} from "@/lib/applications/officialDestination";

async function backfillOfficialDestinations(): Promise<void> {
  const args = process.argv.slice(2);
  const jobIdIndex = args.indexOf("--job-id");
  const limitIndex = args.indexOf("--limit");
  const jobId = jobIdIndex >= 0 ? args[jobIdIndex + 1] : undefined;
  const parsedLimit = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? "", 10) : undefined;
  const jobs = await prisma.job.findMany({
    ...(jobId ? { where: { id: jobId } } : {}),
    orderBy: { createdAt: "asc" },
    ...(parsedLimit && parsedLimit > 0 ? { take: parsedLimit } : {}),
  });
  const companies = await prisma.company.findMany({
    select: { name: true, careersUrl: true },
  });
  const careersByCompany = new Map(
    companies.map((company) => [company.name.trim().toLowerCase(), company.careersUrl]),
  );
  let resolved = 0;
  let unresolved = 0;

  for (const job of jobs) {
    const destination = await resolveOfficialJobDestination(
      {
        ...job,
        employerCareerUrl: careersByCompany.get(job.company.trim().toLowerCase()) ?? null,
      },
      fetch,
      new Date(),
      { followSourceListings: false },
    );
    await prisma.job.update({
      where: { id: job.id },
      data: destinationPersistenceData(destination),
    });
    if (jobId) {
      console.log(
        `${job.id}: ${destination.resolutionStatus} (${destination.resolutionMethod ?? destination.resolutionError ?? "no detail"})`,
      );
    }
    if (destination.resolutionStatus === "RESOLVED") resolved += 1;
    else unresolved += 1;
  }

  console.log(
    `Canonical destination backfill complete: ${resolved} resolved, ${unresolved} unresolved.`,
  );
}

void backfillOfficialDestinations();
