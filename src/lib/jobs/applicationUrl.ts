import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
  type DestinationJob,
} from "@/lib/applications/officialDestination";

export type StoredJobUrls = DestinationJob & {
  redirectChain?: string | null;
};

export type StoredApplicationLinks = {
  applicationUrl: string | null;
  sourceListingUrl: string | null;
};

export const isSourceListingUrl = isAggregatorUrl;

function normalizedFinalUrl(value: string | null | undefined): string | null {
  if (!value || !isValidOfficialApplicationUrl(value)) return null;
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

export function selectStoredApplicationLinks(job: StoredJobUrls): StoredApplicationLinks {
  const applicationUrl =
    job.resolutionStatus === "RESOLVED"
      ? normalizedFinalUrl(job.officialApplicationUrl)
      : null;

  const sourceListingUrl =
    isAggregatorUrl(job.sourceListingUrl)
      ? job.sourceListingUrl ?? null
      : null;

  return { applicationUrl, sourceListingUrl };
}

export function openStoredApplicationUrl(
  job: StoredJobUrls,
  openWindow: (url: string, target: string, features: string) => unknown = window.open,
): boolean {
  const { applicationUrl } = selectStoredApplicationLinks(job);
  if (!applicationUrl) return false;
  openWindow(applicationUrl, "_blank", "noopener,noreferrer");
  return true;
}
