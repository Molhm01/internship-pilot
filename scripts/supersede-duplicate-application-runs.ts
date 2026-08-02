import { prisma } from "@/lib/db";

async function main() {
  const runs = await prisma.applicationRun.findMany({
    where: { status: { in: ["running", "needs_user_action"] } },
    orderBy: { createdAt: "asc" },
  });
  const byJob = new Map<string, typeof runs>();
  for (const run of runs) (byJob.get(run.jobId) ?? (byJob.set(run.jobId, []), byJob.get(run.jobId)!)).push(run);
  let superseded = 0;
  for (const group of byJob.values()) {
    if (group.length < 2) continue;
    const canonical = [...group].sort((a, b) => Number(!!b.stoppedFieldLabel) - Number(!!a.stoppedFieldLabel) || a.createdAt.getTime() - b.createdAt.getTime())[0];
    const ids = group.filter((run) => run.id !== canonical.id).map((run) => run.id);
    const result = await prisma.applicationRun.updateMany({ where: { id: { in: ids } }, data: { status: "superseded", finishedAt: new Date() } });
    superseded += result.count;
  }
  console.log(`Marked ${superseded} duplicate active application run(s) as superseded.`);
}
main().finally(() => prisma.$disconnect());
