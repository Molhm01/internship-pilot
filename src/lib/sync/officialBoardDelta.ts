import { prisma } from "@/lib/db";

export const BOARD_MISSES_BEFORE_CLOSE = 2;

export type TrackedBoardJob = {
  id: string;
  sourceJobId: string | null;
  consecutiveBoardMisses: number;
};

export type BoardDelta = {
  newSourceJobIds: string[];
  presentJobIds: string[];
  missingJobIds: string[];
  closeJobIds: string[];
};

/** Pure board-snapshot comparison. Failed/partial reads pass `successful=false`
 * and can never produce missing or closed jobs. */
export function computeBoardDelta(args: {
  previousSourceJobIds: string[];
  currentSourceJobIds: string[];
  trackedJobs: TrackedBoardJob[];
  successful: boolean;
}): BoardDelta {
  const previous = new Set(args.previousSourceJobIds);
  const current = new Set(args.currentSourceJobIds);
  const newSourceJobIds = args.currentSourceJobIds.filter((id) => !previous.has(id));
  if (!args.successful) {
    return { newSourceJobIds: [], presentJobIds: [], missingJobIds: [], closeJobIds: [] };
  }

  const present = args.trackedJobs.filter((job) => job.sourceJobId && current.has(job.sourceJobId));
  const missing = args.trackedJobs.filter((job) => job.sourceJobId && !current.has(job.sourceJobId));
  return {
    newSourceJobIds,
    presentJobIds: present.map((job) => job.id),
    missingJobIds: missing.map((job) => job.id),
    closeJobIds: missing
      .filter((job) => job.consecutiveBoardMisses + 1 >= BOARD_MISSES_BEFORE_CLOSE)
      .map((job) => job.id),
  };
}

function parseSnapshot(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Persist a successful full-enough board delta. An empty result is deliberately
 * not accepted as closure evidence because several vendors turn network/bot
 * failures into an empty array. This still detects removal from every non-empty
 * board and avoids false closure when employer infrastructure has a bad minute.
 */
export async function reconcileOfficialBoardDelta(args: {
  companyId: string;
  companyName: string;
  provider: string;
  atsTenant: string | null;
  previousSnapshot: string | null;
  currentSourceJobIds: string[];
  now?: Date;
}): Promise<{ newRequisitions: number; missing: number; closed: number; reconciled: boolean }> {
  const currentSourceJobIds = [...new Set(args.currentSourceJobIds.filter(Boolean))].sort();
  if (currentSourceJobIds.length === 0) {
    return { newRequisitions: 0, missing: 0, closed: 0, reconciled: false };
  }

  const trackedJobs = await prisma.job.findMany({
    where: {
      company: { equals: args.companyName },
      atsType: args.provider,
      ...(args.atsTenant ? { atsTenant: args.atsTenant } : {}),
      classification: "QUALIFYING_INTERNSHIP",
    },
    select: { id: true, sourceJobId: true, consecutiveBoardMisses: true },
  });
  const delta = computeBoardDelta({
    previousSourceJobIds: parseSnapshot(args.previousSnapshot),
    currentSourceJobIds,
    trackedJobs,
    successful: true,
  });
  const now = args.now ?? new Date();

  if (delta.presentJobIds.length > 0) {
    await prisma.job.updateMany({
      where: { id: { in: delta.presentJobIds } },
      data: { consecutiveBoardMisses: 0, boardMissingSince: null },
    });
  }
  if (delta.missingJobIds.length > 0) {
    const firstMissIds = trackedJobs
      .filter((job) => delta.missingJobIds.includes(job.id) && job.consecutiveBoardMisses === 0)
      .map((job) => job.id);
    if (firstMissIds.length > 0) {
      await prisma.job.updateMany({
        where: { id: { in: firstMissIds } },
        data: { consecutiveBoardMisses: { increment: 1 }, boardMissingSince: now },
      });
    }
    const repeatedMissIds = delta.missingJobIds.filter((id) => !firstMissIds.includes(id));
    if (repeatedMissIds.length > 0) {
      await prisma.job.updateMany({
        where: { id: { in: repeatedMissIds } },
        data: { consecutiveBoardMisses: { increment: 1 } },
      });
    }
  }
  if (delta.closeJobIds.length > 0) {
    await prisma.job.updateMany({
      where: { id: { in: delta.closeJobIds } },
      data: {
        verificationStatus: "Closed",
        reasonCode: "OFFICIAL_POSTING_REMOVED",
        verificationReason: "Absent from two consecutive successful official board snapshots.",
        classification: "CONFIRMED_CLOSED",
        classificationReason: "Removed from the official employer board after repeated successful checks.",
        activeFeed: false,
        closedAt: now,
      },
    });
  }
  await prisma.company.update({
    where: { id: args.companyId },
    data: { boardSnapshot: JSON.stringify(currentSourceJobIds), lastSuccessfulBoardAt: now },
  });

  return {
    newRequisitions: delta.newSourceJobIds.length,
    missing: delta.missingJobIds.length,
    closed: delta.closeJobIds.length,
    reconciled: true,
  };
}
