export type IcimsAccessClass =
  | "PUBLIC_ENUMERABLE"
  | "PUBLIC_SEARCH_ONLY"
  | "EMPLOYER_MIRROR_AVAILABLE"
  | "STALE_CONFIG"
  | "INVALID_CONFIG"
  | "BOT_WALL";

export function classifyIcimsAccess(input: {
  configState?: string | null;
  errorCode?: string | null;
  evidence?: string | null;
  hasIdentifier?: boolean;
  lastSuccessfulBoardAt?: Date | null;
  activeInternshipCount?: number;
}): IcimsAccessClass {
  const evidence = (input.evidence ?? "").toLowerCase();
  const error = (input.errorCode ?? "").toUpperCase();
  if (error.includes("BOT_WALL") || /bot.wall|captcha|human verification/.test(evidence)) return "BOT_WALL";
  if (/employer.mirror|mirror.available/.test(evidence)) return "EMPLOYER_MIRROR_AVAILABLE";
  if (!input.hasIdentifier || input.configState === "MALFORMED") return "INVALID_CONFIG";
  if (input.configState === "STALE") return "STALE_CONFIG";
  if (input.lastSuccessfulBoardAt || (input.activeInternshipCount ?? 0) > 0) return "PUBLIC_ENUMERABLE";
  return "PUBLIC_SEARCH_ONLY";
}

export type RecallRow = { canonical: boolean; supportedReachable: boolean };

export function calculateRecall(rows: RecallRow[]) {
  const overallDenominator = rows.length;
  const overallCanonical = rows.filter((row) => row.canonical).length;
  const supportedRows = rows.filter((row) => row.supportedReachable);
  const supportedCanonical = supportedRows.filter((row) => row.canonical).length;
  return {
    overallDenominator,
    overallCanonical,
    overallRecall: overallDenominator ? overallCanonical / overallDenominator : null,
    supportedReachableDenominator: supportedRows.length,
    supportedReachableCanonical: supportedCanonical,
    supportedReachableRecall: supportedRows.length ? supportedCanonical / supportedRows.length : null,
  };
}

export type FreshLatencyRow = {
  sourceCapturedAt: Date;
  officialResolutionStartedAt: Date | null;
  canonicalStoredAt: Date | null;
  supportedReachable: boolean;
};

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}

export function calculateFreshLatency(rows: FreshLatencyRow[], cohortStartedAt: Date) {
  const durations = rows
    .filter((row) => row.supportedReachable && row.sourceCapturedAt >= cohortStartedAt && row.canonicalStoredAt)
    .map((row) => row.canonicalStoredAt!.getTime() - row.sourceCapturedAt.getTime())
    .filter((duration) => duration >= 0);
  return { cohortSize: durations.length, medianMs: percentile(durations, 0.5), p90Ms: percentile(durations, 0.9) };
}

export type MissingProviderCandidate = {
  name: string;
  engineeringActivityTier?: string | null;
  priority?: string | null;
  activeInternshipCount?: number;
  recentUnresolvedSignals?: number;
  atsType?: string | null;
};

export function rankMissingProviders(rows: MissingProviderCandidate[]): MissingProviderCandidate[] {
  const score = (row: MissingProviderCandidate) =>
    (row.engineeringActivityTier === "A" ? 100 : row.engineeringActivityTier === "B" ? 50 : 0)
    + (row.priority === "priority" ? 40 : row.priority === "standard" ? 10 : 0)
    + Math.min(50, (row.activeInternshipCount ?? 0) * 5)
    + Math.min(100, (row.recentUnresolvedSignals ?? 0) * 10)
    + (["eightfold", "phenom", "smartrecruiters", "successfactors"].includes(row.atsType ?? "") ? 20 : 0);
  return [...rows].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}
