import { prisma } from "@/lib/db";

const EVENT_PREFIX = "liveDiscovery:event:";
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const TERMINAL_STATES = new Set(["resolved", "closed", "abandoned"]);

type EventEnvelope = { state?: unknown };

function terminal(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as EventEnvelope;
    return typeof parsed.state === "string" && TERMINAL_STATES.has(parsed.state);
  } catch {
    return false;
  }
}

export async function pruneTerminalLiveDiscoveryEvents(now = new Date()): Promise<number> {
  const oldRows = await prisma.appSetting.findMany({
    where: {
      key: { startsWith: EVENT_PREFIX },
      updatedAt: { lt: new Date(now.getTime() - RETENTION_MS) },
    },
    select: { key: true, value: true },
    take: 1000,
  });
  const keys = oldRows.filter((row) => terminal(row.value)).map((row) => row.key);
  if (keys.length === 0) return 0;
  const result = await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
  return result.count;
}
