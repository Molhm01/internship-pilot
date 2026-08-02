import "dotenv/config";
import { prisma } from "@/lib/db";

async function main() {
  const bySource = await prisma.job.groupBy({ by: ["source", "verificationStatus"], _count: true });
  console.log("=== source x verificationStatus ===");
  for (const row of bySource.sort((a, b) => (a.source ?? "").localeCompare(b.source ?? ""))) {
    console.log(`${(row.source ?? "(null)").padEnd(16)} ${row.verificationStatus.padEnd(24)} ${row._count}`);
  }

  const samples = await prisma.job.findMany({
    where: { verificationStatus: { in: ["ACTIVE_SOURCE_LISTED", "NeedsReview", "Closed"] } },
    select: { company: true, verificationStatus: true, reasonCode: true, verificationReason: true },
    take: 8,
  });
  console.log("\n=== sample reasons (post-repair) ===");
  for (const j of samples) {
    console.log(`- [${j.verificationStatus}] ${j.company} (code=${j.reasonCode ?? "-"})`);
    console.log(`    ${JSON.stringify(j.verificationReason)?.slice(0, 180)}`);
  }

  const all = await prisma.job.findMany({ select: { verificationReason: true } });
  const recursive = all.filter((j) => /(POSTING_CLOSED|EMPLOYER_NOT_APPROVED):\s*(POSTING_CLOSED|EMPLOYER_NOT_APPROVED):/.test(j.verificationReason ?? ""));
  const emptyish = all.filter((j) => (j.verificationReason ?? "").trim().length < 5);
  console.log(`\nrecursive-prefix remaining: ${recursive.length}`);
  console.log(`suspiciously-empty reasons: ${emptyish.length}`);

  const va = await prisma.verificationAttempt.count();
  console.log(`\nVerificationAttempt rows: ${va}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
