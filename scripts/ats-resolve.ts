// Resolve which ATS each allowlisted company uses and persist its tenant id.
//
// Strongest path: inspect the employer's own careers page for a redirect/link
// to Greenhouse, Lever, Ashby, SmartRecruiters, or Workday. Conservative
// Greenhouse/Lever/Ashby slug probing remains a fallback.
//
// Safe by default: --dry-run reports what it WOULD set and writes nothing.
//
//   npm run ats:resolve -- --dry-run
//   npm run ats:resolve -- --apply
//   npm run ats:resolve -- --apply --limit=50

import { prisma } from "@/lib/db";
import { resolveAtsForCompany } from "@/lib/ats/resolve";

type Args = { apply: boolean; limit: number | null; throttleMs: number };

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const throttleArg = argv.find((a) => a.startsWith("--throttle="));
  return {
    apply,
    limit: limitArg ? parseInt(limitArg.split("=")[1], 10) : null,
    throttleMs: throttleArg ? parseInt(throttleArg.split("=")[1], 10) : 250,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(`[ats:resolve] mode=${mode} throttle=${args.throttleMs}ms`);

  const candidates = await prisma.company.findMany({
    where: {
      allowlisted: true,
      OR: [{ atsType: null }, { atsType: "unknown" }, { atsIdentifier: null }],
    },
    select: { id: true, name: true, website: true, careersUrl: true, atsType: true },
    orderBy: { name: "asc" },
    ...(args.limit ? { take: args.limit } : {}),
  });

  console.log(`[ats:resolve] resolving ${candidates.length} companies\n`);

  let resolved = 0;
  let unresolved = 0;
  let failed = 0;
  const byVendor: Record<string, number> = {};
  const byMethod: Record<string, number> = {};

  for (const company of candidates) {
    try {
      // The official careers page is deliberately preferred over the general
      // corporate website because a direct ATS link/redirect is ownership
      // evidence, not a guessed tenant.
      const resolutionUrl = company.careersUrl ?? company.website;
      const hit = await resolveAtsForCompany(company.name, resolutionUrl, {
        throttleMs: args.throttleMs,
      });
      if (!hit) {
        unresolved += 1;
        continue;
      }

      resolved += 1;
      byVendor[hit.atsType] = (byVendor[hit.atsType] ?? 0) + 1;
      byMethod[hit.method] = (byMethod[hit.method] ?? 0) + 1;
      const countLabel = hit.postingCount >= 0 ? `${hit.postingCount} postings` : "careers-page evidence";
      console.log(
        `  ✓ ${company.name} -> ${hit.atsType}/${hit.atsIdentifier} (${hit.method}; ${countLabel})`,
      );

      if (args.apply) {
        await prisma.$transaction(async (tx) => {
          await tx.company.update({
            where: { id: company.id },
            data: {
              atsType: hit.atsType,
              atsIdentifier: hit.atsIdentifier,
              lastCheckStatus: "success",
              lastCheckError: null,
              consecutiveFailures: 0,
            },
          });

          // A direct link/redirect from the employer's own careers page is the
          // strongest tenant-ownership evidence we have. Persist it once so
          // company discovery and application routing do not need to re-prove
          // the same relationship on every cycle.
          if (hit.method === "careers-page" && company.careersUrl) {
            await tx.approvedAtsTenant.upsert({
              where: {
                companyId_atsType_atsIdentifier: {
                  companyId: company.id,
                  atsType: hit.atsType,
                  atsIdentifier: hit.atsIdentifier,
                },
              },
              update: {
                discoveredFromCareersUrl: company.careersUrl,
                evidence: JSON.stringify({
                  method: "careers-page-resolution",
                  sourceUrl: hit.boardUrl,
                  confirmedAt: new Date().toISOString(),
                }),
              },
              create: {
                companyId: company.id,
                atsType: hit.atsType,
                atsIdentifier: hit.atsIdentifier,
                discoveredFromCareersUrl: company.careersUrl,
                evidence: JSON.stringify({
                  method: "careers-page-resolution",
                  sourceUrl: hit.boardUrl,
                  confirmedAt: new Date().toISOString(),
                }),
              },
            });
          }
        });
      }
    } catch (error) {
      failed += 1;
      console.log(
        `  ! ${company.name}: resolution failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
  }

  console.log(`\n[ats:resolve] ${mode} complete`);
  console.log(`  companies checked : ${candidates.length}`);
  console.log(`  resolved          : ${resolved} ${JSON.stringify(byVendor)}`);
  console.log(`  methods           : ${JSON.stringify(byMethod)}`);
  console.log(`  unresolved        : ${unresolved}`);
  console.log(`  failures          : ${failed}`);
  if (!args.apply) console.log(`\n  Nothing was written. Re-run with --apply to persist.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ats:resolve] fatal", e);
    process.exit(1);
  });
