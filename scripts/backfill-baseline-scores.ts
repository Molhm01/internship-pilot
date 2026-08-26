import "dotenv/config";
import { prisma } from "@/lib/db";
import { backfillBaselineScoresForUser } from "@/lib/matching/baselineScoring";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

async function selectedUsers(): Promise<Array<{ id: string; email: string }>> {
  const userId = argument("--user");
  const email = argument("--email");
  const allEligible = process.argv.includes("--all-eligible");
  if ([Boolean(userId), Boolean(email), allEligible].filter(Boolean).length !== 1) {
    throw new Error("Choose exactly one: --user <id>, --email <address>, or --all-eligible");
  }
  if (userId) return prisma.user.findMany({ where: { id: userId }, select: { id: true, email: true } });
  if (email) return prisma.user.findMany({ where: { email }, select: { id: true, email: true } });
  return prisma.user.findMany({
    where: { resumeFacts: { some: { status: { in: ["approved", "edited"] } } } },
    orderBy: { id: "asc" },
    select: { id: true, email: true },
  });
}

async function main() {
  const users = await selectedUsers();
  if (users.length === 0) throw new Error("No matching eligible user was found.");
  for (const user of users) {
    const startedAt = performance.now();
    const result = await backfillBaselineScoresForUser(user.id);
    const scored = await prisma.job.count({
      where: {
        activeFeed: true,
        userStates: { some: { userId: user.id, matchScore: { gte: 0, lte: 100 } } },
      },
    });
    const active = await prisma.job.count({ where: { activeFeed: true } });
    console.log(JSON.stringify({
      userId: user.id,
      profileReady: result.profileReady,
      active,
      scored,
      unscored: active - scored,
      coverage: active === 0 ? 100 : Number((100 * scored / active).toFixed(2)),
      baselineWritten: result.baselineWritten,
      alreadyCurrent: result.alreadyCurrent,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
