// Resolve which companies use Greenhouse / Lever / Ashby, and what their
// public board token is.
//
// This is the unlock for direct ATS ingestion: 600 of 636 companies carried
// atsType "unknown" with no identifier, so only three employers were ever
// reachable. Probing the vendors' public, documented, unauthenticated board
// APIs turns those into ingestible boards.
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

  // Only companies we are allowed to monitor, and only ones not already
  // resolved — re-probing a known board wastes requests.
  const candidates = await prisma.company.findMany({
    where: {
      allowlisted: true,
      OR: [{ atsType: null }, { atsType: "unknown" }, { atsIdentifier: null }],
    },
    select: { id: true, name: true, website: true, careersUrl: true, atsType: true },
    orderBy: { name: "asc" },
    ...(args.limit ? { take: args.limit } : {}),
  });

  console.log(`[ats:resolve] probing ${candidates.length} companies\n`);

  let resolved = 0;
  let unresolved = 0;
  let failed = 0;
  const byVendor: Record<string, number> = {};

  for (const company of candidates) {
    try {
      const hit = await resolveAtsForCompany(company.name, company.website ?? company.careersUrl, {
        throttleMs: args.throttleMs,
      });
      if (!hit) {
        unresolved += 1;
        continue;
      }
      resolved += 1;
      byVendor[hit.atsType] = (byVendor[hit.atsType] ?? 0) + 1;
      console.log(
        `  ✓ ${company.name} -> ${hit.atsType}/${hit.atsIdentifier} (${hit.postingCount} postings)`,
      );
      if (args.apply) {
        await prisma.company.update({
          where: { id: company.id },
          data: {
            atsType: hit.atsType,
            atsIdentifier: hit.atsIdentifier,
            lastCheckStatus: "success",
            lastCheckError: null,
            consecutiveFailures: 0,
          },
        });
      }
    } catch (error) {
      // A single unreachable company must never end the sweep.
      failed += 1;
      console.log(
        `  ! ${company.name}: probe failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
  }

  console.log(`\n[ats:resolve] ${mode} complete`);
  console.log(`  companies probed : ${candidates.length}`);
  console.log(`  resolved         : ${resolved} ${JSON.stringify(byVendor)}`);
  console.log(`  unresolved       : ${unresolved}`);
  console.log(`  probe failures   : ${failed}`);
  if (!args.apply) console.log(`\n  Nothing was written. Re-run with --apply to persist.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ats:resolve] fatal", e);
    process.exit(1);
  });
