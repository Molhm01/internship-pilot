import type { FreshSignalReason } from "@/lib/sync/freshSignalReasons";

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

export function isUsableProviderConfig(input: {
  atsType: string | null;
  atsIdentifier: string | null;
  careersUrl: string | null;
}): boolean {
  const provider = reportProvider(input.atsType);
  if (provider === "Unknown") return false;
  if (provider === "SuccessFactors") return Boolean(input.careersUrl);
  if (provider === "Custom/API") {
    // An ordinary custom careers URL is provider knowledge, not a usable
    // structured configuration. Only adapters with a discovered structured
    // surface count as directly pollable here.
    return ["spa", "employer-page", "api", "usajobs"].includes((input.atsType ?? "").toLowerCase())
      && Boolean(input.careersUrl || input.atsIdentifier);
  }
  const identifier = (input.atsIdentifier ?? "").trim();
  if (["Greenhouse", "Lever", "Ashby", "SmartRecruiters"].includes(provider)) {
    if (/^(embed|jobs?|careers?|search|home|external|internal)$/i.test(identifier)) return false;
  }
  if (provider === "Workday") {
    const site = identifier.split("/")[1] ?? "";
    if (!site || /^[a-z]{2}(?:-[A-Z]{2})?$/i.test(site)) return false;
  }
  return Boolean(input.atsIdentifier);
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
  if (["NO_BOARD_MATCH", "TITLE_MATCH_TOO_LOW", "LOCATION_MISMATCH"].includes(input.reasonCode ?? "")) {
    return "OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED";
  }
  if (input.reasonCode === "PARSER_FAILURE") return "SOURCE_SIGNAL_IRRELEVANT";
  return "UNRESOLVED";
}

export type GapGroup =
  | "provider missing"
  | "provider bot wall"
  | "company/domain unknown"
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
    case "ATS_BOARD_FETCH_FAILED":
    case "NETWORK_FAILURE":
    case "RATE_LIMITED": return "board fetch failed";
    case "NO_BOARD_MATCH": return "official posting indexing delay";
    case "TITLE_MATCH_TOO_LOW":
    case "LOCATION_MISMATCH": return "matching failure";
    case "POSTING_CLOSED": return "stale source signal";
    case "PARSER_FAILURE": return "source false positive";
    case "NO_OFFICIAL_URL":
    case "OFFICIAL_URL_REJECTED":
    default: return "custom-site unsupported";
  }
}
