import { listGreenhouseJobs } from "@/lib/ats/greenhouse";
import { listLeverJobs } from "@/lib/ats/lever";
import { probeWorkdayJobs } from "@/lib/ats/workday";
import { probeStructuredPortalJobs } from "@/lib/ats/structuredCareer";
import type { AtsJob } from "@/lib/ats/types";
import { detectAtsForCareersPage, detectAtsFromText } from "@/lib/ats/detect";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import {
  postingQualityTelemetry,
  syntacticConfigState,
  type AtsConfigState,
  type PostingQualityTelemetry,
} from "@/lib/sync/officialDiscoveryMetrics";

export type ProviderProbeCompany = {
  name: string;
  atsType: string | null;
  atsIdentifier: string | null;
  careersUrl: string | null;
};

export type ProviderAccess =
  | "API_READABLE"
  | "HTTP_READABLE"
  | "EMPLOYER_MIRROR"
  | "BOT_WALL_BLOCKED"
  | "HEADLESS_READABLE"
  | "NOT_APPLICABLE"
  | "UNREACHABLE";

export type OfficialProviderProbe = {
  company: string;
  provider: string;
  configState: AtsConfigState;
  access: ProviderAccess;
  attemptedIdentifier: string | null;
  suggestedIdentifier: string | null;
  jobs: AtsJob[];
  jobsScanned: number;
  totalAvailableJobs: number;
  engineeringJobs: AtsJob[];
  paginationVerified: boolean;
  quality: PostingQualityTelemetry;
  engineeringQuality: PostingQualityTelemetry;
  durationMs: number;
  errorCode: string | null;
  evidence: Record<string, unknown>;
};

const INTERNSHIP_HINT = /\b(intern(?:ship)?s?|co-?ops?|student)\b/i;

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code).slice(0, 80);
  return "ATS_PROBE_FAILED";
}

function stateForFailure(code: string): AtsConfigState {
  if (code === "ATS_CONFIG_MALFORMED") return "MALFORMED";
  if (["ATS_HTTP_404", "ATS_HTTP_410", "ATS_SCHEMA_INVALID", "ATS_BOARD_UNREACHABLE"].includes(code)) {
    return "STALE";
  }
  return "UNTESTED";
}

function emptyProbe(
  company: ProviderProbeCompany,
  state: AtsConfigState,
  started: number,
  code: string | null = null,
): OfficialProviderProbe {
  const quality = postingQualityTelemetry([], new Date());
  return {
    company: company.name,
    provider: company.atsType ?? "unknown",
    configState: state,
    access: "UNREACHABLE",
    attemptedIdentifier: company.atsIdentifier,
    suggestedIdentifier: null,
    jobs: [],
    jobsScanned: 0,
    totalAvailableJobs: 0,
    engineeringJobs: [],
    paginationVerified: false,
    quality,
    engineeringQuality: quality,
    durationMs: Date.now() - started,
    errorCode: code,
    evidence: {},
  };
}

async function discoverValidatedGreenhouse(
  company: ProviderProbeCompany,
  evidenceUrls: readonly string[] = [],
): Promise<{ identifier: string; jobs: AtsJob[] } | null> {
  const candidates = new Set<string>();
  if (company.careersUrl) {
    const detected = await detectAtsForCareersPage(company.careersUrl);
    if (detected.atsType === "greenhouse" && detected.atsIdentifier) candidates.add(detected.atsIdentifier);
  }
  for (const url of evidenceUrls) {
    const detected = detectAtsFromText(url);
    if (detected.atsType === "greenhouse" && detected.atsIdentifier) candidates.add(detected.atsIdentifier);
  }
  for (const identifier of candidates) {
    try {
      return { identifier, jobs: await listGreenhouseJobs(identifier, company.name) };
    } catch {
      // A historical URL can carry a retired slug; try the next evidenced one.
    }
  }
  return null;
}

async function discoverValidatedWorkday(
  company: ProviderProbeCompany,
  evidenceUrls: readonly string[] = [],
) {
  const candidates = new Set<string>();
  for (const url of evidenceUrls) {
    const detected = detectAtsFromText(url);
    if (detected.atsType === "workday" && detected.atsIdentifier) candidates.add(detected.atsIdentifier);
  }
  if (candidates.size === 0 && company.careersUrl) {
    const detected = await detectAtsForCareersPage(company.careersUrl);
    if (detected.atsType === "workday" && detected.atsIdentifier) candidates.add(detected.atsIdentifier);
  }
  for (const identifier of candidates) {
    try {
      const probe = await probeWorkdayJobs(identifier, company.careersUrl, company.name, (title) => INTERNSHIP_HINT.test(title));
      return { identifier, probe };
    } catch {
      // Try the next employer-evidenced tenant/site.
    }
  }
  return null;
}

export async function probeOfficialProvider(
  company: ProviderProbeCompany,
  options: {
    discoverGreenhouse?: boolean;
    greenhouseEvidenceUrls?: readonly string[];
    discoverWorkday?: boolean;
    workdayEvidenceUrls?: readonly string[];
  } = {},
): Promise<OfficialProviderProbe> {
  const started = Date.now();
  const syntax = syntacticConfigState(company);
  if (syntax !== "UNTESTED") {
    if (company.atsType === "greenhouse" && options.discoverGreenhouse) {
      const discovered = await discoverValidatedGreenhouse(company, options.greenhouseEvidenceUrls);
      if (discovered) {
        const engineeringJobs = discovered.jobs.filter((job) => isTargetEngineeringRole(job.title, job.description));
        return {
          company: company.name,
          provider: "greenhouse",
          configState: "VALIDATED",
          access: "API_READABLE",
          attemptedIdentifier: company.atsIdentifier,
          suggestedIdentifier: discovered.identifier,
          jobs: discovered.jobs,
          jobsScanned: discovered.jobs.length,
          totalAvailableJobs: discovered.jobs.length,
          engineeringJobs,
          paginationVerified: true,
          quality: postingQualityTelemetry(discovered.jobs, new Date()),
          engineeringQuality: postingQualityTelemetry(engineeringJobs, new Date()),
          durationMs: Date.now() - started,
          errorCode: null,
          evidence: { repairedBy: "employer-careers-page-detection" },
        };
      }
    }
    if (company.atsType === "workday" && options.discoverWorkday) {
      const discovered = await discoverValidatedWorkday(company, options.workdayEvidenceUrls);
      if (discovered) {
        const engineeringJobs = discovered.probe.jobs.filter((job) => isTargetEngineeringRole(job.title, job.description));
        return {
          company: company.name,
          provider: "workday",
          configState: "VALIDATED",
          access: "API_READABLE",
          attemptedIdentifier: company.atsIdentifier,
          suggestedIdentifier: discovered.identifier,
          jobs: discovered.probe.jobs,
          jobsScanned: discovered.probe.internshipPostingsScanned,
          totalAvailableJobs: discovered.probe.totalAvailableJobs,
          engineeringJobs,
          paginationVerified: discovered.probe.paginationVerified,
          quality: postingQualityTelemetry(discovered.probe.jobs, new Date()),
          engineeringQuality: postingQualityTelemetry(engineeringJobs, new Date()),
          durationMs: Date.now() - started,
          errorCode: null,
          evidence: { repairedBy: "employer-or-canonical-workday-evidence", ...discovered.probe.configuration },
        };
      }
    }
    return emptyProbe(company, syntax, started, syntax === "MALFORMED" ? "ATS_CONFIG_MALFORMED" : null);
  }

  const provider = (company.atsType ?? "").toLowerCase();
  const identifier = company.atsIdentifier ?? "";
  try {
    let jobs: AtsJob[] = [];
    let jobsScanned = 0;
    let totalAvailableJobs = 0;
    let paginationVerified = false;
    let access: ProviderAccess = "API_READABLE";
    let evidence: Record<string, unknown> = {};

    if (provider === "greenhouse") {
      jobs = await listGreenhouseJobs(identifier, company.name);
      jobsScanned = totalAvailableJobs = jobs.length;
      paginationVerified = true;
    } else if (provider === "lever") {
      jobs = await listLeverJobs(identifier, company.name);
      jobsScanned = totalAvailableJobs = jobs.length;
      paginationVerified = true;
    } else if (provider === "workday") {
      const probe = await probeWorkdayJobs(
        identifier,
        company.careersUrl,
        company.name,
        (title) => INTERNSHIP_HINT.test(title),
      );
      jobs = probe.jobs;
      jobsScanned = probe.internshipPostingsScanned;
      totalAvailableJobs = probe.totalAvailableJobs;
      paginationVerified = probe.paginationVerified;
      evidence = {
        tenant: probe.configuration.tenant,
        site: probe.configuration.site,
        shard: probe.configuration.shard,
        derivedFromCareersUrl: probe.configuration.derivedFromCareersUrl,
      };
    } else if (provider === "successfactors") {
      const probe = await probeStructuredPortalJobs({
        kind: "successfactors",
        companyName: company.name,
        careersUrl: company.careersUrl!,
        maxListPages: 8,
        maxJobDetails: 40,
      });
      jobs = probe.jobs;
      jobsScanned = probe.detailLinksFound;
      totalAvailableJobs = probe.detailLinksFound;
      paginationVerified = probe.readableListPages > 1 || probe.detailLinksFound <= 40;
      access = probe.employerMirrorAvailable ? "EMPLOYER_MIRROR" : probe.botWallBlocked ? "BOT_WALL_BLOCKED" : "HTTP_READABLE";
      evidence = probe;
      if (probe.readableListPages === 0 || probe.detailLinksFound === 0) {
        const failed = emptyProbe(company, probe.botWallBlocked ? "UNTESTED" : "STALE", started,
          probe.botWallBlocked ? "ATS_BOT_WALL" : "ATS_ENUMERATION_EMPTY");
        return { ...failed, access, evidence };
      }
    } else if (provider === "icims") {
      const probe = await probeStructuredPortalJobs({
        kind: "icims",
        companyName: company.name,
        careersUrl: company.careersUrl!,
        additionalStartUrls: [`https://${identifier}.icims.com/jobs/search?ss=1`],
        maxListPages: 6,
        maxJobDetails: 35,
      });
      jobs = probe.jobs;
      jobsScanned = probe.detailLinksFound;
      totalAvailableJobs = probe.detailLinksFound;
      paginationVerified = probe.readableListPages > 1 || probe.detailLinksFound <= 35;
      access = probe.employerMirrorAvailable ? "EMPLOYER_MIRROR" : probe.botWallBlocked ? "BOT_WALL_BLOCKED" : "HTTP_READABLE";
      evidence = probe;
      if (probe.readableListPages === 0 || probe.detailLinksFound === 0) {
        const failed = emptyProbe(company, probe.botWallBlocked ? "UNTESTED" : "STALE", started,
          probe.botWallBlocked ? "ATS_BOT_WALL" : "ATS_ENUMERATION_EMPTY");
        return { ...failed, access, evidence };
      }
    } else {
      return emptyProbe(company, "UNSUPPORTED", started, "ATS_PROVIDER_UNSUPPORTED");
    }

    const engineeringJobs = jobs.filter((job) => isTargetEngineeringRole(job.title, job.description));
    return {
      company: company.name,
      provider,
      configState: "VALIDATED",
      access,
      attemptedIdentifier: company.atsIdentifier,
      suggestedIdentifier: null,
      jobs,
      jobsScanned,
      totalAvailableJobs,
      engineeringJobs,
      paginationVerified,
      quality: postingQualityTelemetry(jobs, new Date()),
      engineeringQuality: postingQualityTelemetry(engineeringJobs, new Date()),
      durationMs: Date.now() - started,
      errorCode: null,
      evidence,
    };
  } catch (error) {
    const code = errorCode(error);
    if (provider === "greenhouse" && options.discoverGreenhouse) {
      const discovered = await discoverValidatedGreenhouse(company, options.greenhouseEvidenceUrls);
      if (discovered && discovered.identifier !== identifier) {
        const engineeringJobs = discovered.jobs.filter((job) => isTargetEngineeringRole(job.title, job.description));
        return {
          company: company.name,
          provider,
          configState: "VALIDATED",
          access: "API_READABLE",
          attemptedIdentifier: identifier,
          suggestedIdentifier: discovered.identifier,
          jobs: discovered.jobs,
          jobsScanned: discovered.jobs.length,
          totalAvailableJobs: discovered.jobs.length,
          engineeringJobs,
          paginationVerified: true,
          quality: postingQualityTelemetry(discovered.jobs, new Date()),
          engineeringQuality: postingQualityTelemetry(engineeringJobs, new Date()),
          durationMs: Date.now() - started,
          errorCode: null,
          evidence: { repairedBy: "employer-careers-page-detection", originalError: code },
        };
      }
    }
    if (provider === "workday" && options.discoverWorkday) {
      const discovered = await discoverValidatedWorkday(company, options.workdayEvidenceUrls);
      if (discovered && discovered.identifier !== identifier) {
        const engineeringJobs = discovered.probe.jobs.filter((job) => isTargetEngineeringRole(job.title, job.description));
        return {
          company: company.name,
          provider,
          configState: "VALIDATED",
          access: "API_READABLE",
          attemptedIdentifier: identifier,
          suggestedIdentifier: discovered.identifier,
          jobs: discovered.probe.jobs,
          jobsScanned: discovered.probe.internshipPostingsScanned,
          totalAvailableJobs: discovered.probe.totalAvailableJobs,
          engineeringJobs,
          paginationVerified: discovered.probe.paginationVerified,
          quality: postingQualityTelemetry(discovered.probe.jobs, new Date()),
          engineeringQuality: postingQualityTelemetry(engineeringJobs, new Date()),
          durationMs: Date.now() - started,
          errorCode: null,
          evidence: { repairedBy: "employer-or-canonical-workday-evidence", originalError: code, ...discovered.probe.configuration },
        };
      }
    }
    return emptyProbe(company, stateForFailure(code), started, code);
  }
}
