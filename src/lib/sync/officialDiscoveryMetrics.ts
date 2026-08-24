import type { FreshSignalReason } from "@/lib/sync/freshSignalReasons";
import type { AtsJob } from "@/lib/ats/types";
import { parseFirstSourceDate } from "@/lib/sync/sourceDate";

export const REPORT_PROVIDERS = [
  "Greenhouse",
  "Lever",
  "Ashby",
  "Workday",
  "SmartRecruiters",
  "SuccessFactors",
  "Eightfold",
  "Phenom",
  "iCIMS",
  "Custom/API",
  "Unknown",
] as const;
export type ReportProvider = (typeof REPORT_PROVIDERS)[number];

export const ATS_CONFIG_STATES = [
  "VALIDATED",
  "STALE",
  "MALFORMED",
  "UNTESTED",
  "UNSUPPORTED",
  "CUSTOM",
] as const;
export type AtsConfigState = (typeof ATS_CONFIG_STATES)[number];

export function reportProvider(raw: string | null | undefined): ReportProvider {
  const provider = (raw ?? "").trim().toLowerCase().replace(/^ats:/, "");
  if (provider === "greenhouse") return "Greenhouse";
  if (provider === "lever") return "Lever";
  if (provider === "ashby") return "Ashby";
  if (provider === "workday") return "Workday";
  if (provider === "smartrecruiters") return "SmartRecruiters";
  if (provider === "successfactors") return "SuccessFactors";
  if (provider === "eightfold") return "Eightfold";
  if (provider === "phenom") return "Phenom";
  if (provider === "icims") return "iCIMS";
  if (["custom", "spa", "employer-page", "taleo", "usajobs", "api", "other"].includes(provider)) {
    return "Custom/API";
  }
  return "Unknown";
}

export function syntacticConfigState(input: {
  atsType: string | null;
  atsIdentifier: string | null;
  careersUrl: string | null;
}): AtsConfigState {
  const provider = reportProvider(input.atsType);
  if (provider === "Unknown") return "UNSUPPORTED";
  if (provider === "Custom/API") {
    return "CUSTOM";
  }
  if (provider === "SuccessFactors") return input.careersUrl ? "UNTESTED" : "MALFORMED";
  const identifier = (input.atsIdentifier ?? "").trim();
  if (!identifier) return "MALFORMED";
  if (["Greenhouse", "Lever", "Ashby", "SmartRecruiters"].includes(provider)) {
    if (/^(embed|jobs?|careers?|search|home|external|internal)$/i.test(identifier)) return "MALFORMED";
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(identifier)) return "MALFORMED";
  }
  if (provider === "Workday") {
    const site = identifier.split("/")[1] ?? "";
    const tenant = identifier.split("/")[0] ?? "";
    if (!tenant || !site || /^[a-z]{2}(?:-[A-Z]{2})?$/i.test(site)) return "MALFORMED";
    if (!/^[a-z0-9-]+(?:\.wd\d+)?$/i.test(tenant)) return "MALFORMED";
  }
  if (provider === "iCIMS" && !/^[a-z0-9-]+$/i.test(identifier)) return "MALFORMED";
  return "UNTESTED";
}

/** A usable ATS is proven by a live enumeration, never by an enum alone. */
export function isUsableProviderConfig(input: {
  atsType: string | null;
  atsIdentifier: string | null;
  careersUrl: string | null;
  atsConfigState?: string | null;
}): boolean {
  return syntacticConfigState(input) === "UNTESTED" && input.atsConfigState === "VALIDATED";
}

export function normalizedConfigState(input: {
  atsType: string | null;
  atsIdentifier: string | null;
  careersUrl: string | null;
  atsConfigState?: string | null;
}): AtsConfigState {
  const syntax = syntacticConfigState(input);
  if (syntax !== "UNTESTED") return syntax;
  return ATS_CONFIG_STATES.includes(input.atsConfigState as AtsConfigState)
    ? input.atsConfigState as AtsConfigState
    : "UNTESTED";
}

export type PostingQualityTelemetry = {
  fullJdJobs: number;
  exactTimestampJobs: number;
  dateOnlyJobs: number;
  relativeParsedJobs: number;
  radarFallbackJobs: number;
  unknownTimestampJobs: number;
};

export function postingQualityTelemetry(
  jobs: AtsJob[],
  capturedAt: Date,
  radarFallbackIds: ReadonlySet<string> = new Set(),
): PostingQualityTelemetry {
  const telemetry: PostingQualityTelemetry = {
    fullJdJobs: 0,
    exactTimestampJobs: 0,
    dateOnlyJobs: 0,
    relativeParsedJobs: 0,
    radarFallbackJobs: 0,
    unknownTimestampJobs: 0,
  };
  for (const job of jobs) {
    if (job.description.trim().length > 200) telemetry.fullJdJobs += 1;
    if (radarFallbackIds.has(job.sourceJobId)) {
      telemetry.radarFallbackJobs += 1;
      continue;
    }
    const parsed = parseFirstSourceDate([job.postedAt, job.postedAtText], capturedAt);
    if (parsed.sourceDateConfidence === "EXACT") telemetry.exactTimestampJobs += 1;
    else if (parsed.sourceDateConfidence === "DATE_ONLY") telemetry.dateOnlyJobs += 1;
    else if (parsed.sourceDateConfidence === "RELATIVE_PARSED") telemetry.relativeParsedJobs += 1;
    else telemetry.unknownTimestampJobs += 1;
  }
  return telemetry;
}

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
}

export type FreshRecallClass =
  | "ALREADY_FOUND_OFFICIALLY"
  | "RESOLVED_AFTER_PRIORITY_TRIGGER"
  | "OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED"
  | "SOURCE_SIGNAL_STALE"
  | "SOURCE_SIGNAL_IRRELEVANT"
  | "UNRESOLVED";

export function classifyFreshRecall(input: {
  state: string;
  workflowState?: string | null;
  resolutionPath: string | null;
  reasonCode: string | null;
}): FreshRecallClass {
  if (input.state === "RESOLVED" || input.workflowState === "OFFICIAL_RESOLVED") {
    return input.resolutionPath === "already_official"
      ? "ALREADY_FOUND_OFFICIALLY"
      : "RESOLVED_AFTER_PRIORITY_TRIGGER";
  }
  if (input.state === "CLOSED" || input.reasonCode === "POSTING_CLOSED") return "SOURCE_SIGNAL_STALE";
  if (["NO_BOARD_MATCH", "BOARD_ROLE_NOT_INDEXED", "TITLE_MATCH_TOO_LOW", "LOCATION_MISMATCH"].includes(input.reasonCode ?? "")) {
    return "OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED";
  }
  if (input.reasonCode === "PARSER_FAILURE") return "SOURCE_SIGNAL_IRRELEVANT";
  return "UNRESOLVED";
}

export type GapGroup =
  | "provider missing"
  | "provider bot wall"
  | "company/domain unknown"
  | "wrong employer board"
  | "official posting indexing delay"
  | "board fetch failed"
  | "matching failure"
  | "stale source signal"
  | "source false positive"
  | "custom-site unsupported";

export function gapGroup(reason: FreshSignalReason | string | null): GapGroup {
  switch (reason) {
    case "NO_ATS_CONFIG": return "provider missing";
    case "BOT_WALL_BLOCKED": return "provider bot wall";
    case "UNKNOWN_COMPANY": return "company/domain unknown";
    case "BOARD_WRONG_EMPLOYER": return "wrong employer board";
    case "ATS_BOARD_FETCH_FAILED":
    case "NETWORK_FAILURE":
    case "RATE_LIMITED": return "board fetch failed";
    case "NO_BOARD_MATCH":
    case "BOARD_ROLE_NOT_INDEXED": return "official posting indexing delay";
    case "TITLE_MATCH_TOO_LOW":
    case "LOCATION_MISMATCH": return "matching failure";
    case "POSTING_CLOSED": return "stale source signal";
    case "PARSER_FAILURE": return "source false positive";
    case "NO_OFFICIAL_URL":
    case "OFFICIAL_URL_REJECTED":
    default: return "custom-site unsupported";
  }
}
