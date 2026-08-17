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
  openWindow?: (url: string, target: string, features: string) => unknown,
): boolean {
  const { applicationUrl } = selectStoredApplicationLinks(job);
  if (!applicationUrl) return false;

  // Do not detach `window.open` from `window`. Some browsers reject the
  // unbound native method with an "Illegal invocation", which made both the
  // Discover-card Apply button and the job-detail "Open without agent" button
  // appear to do nothing. Keep an injectable opener for tests, but call the
  // real browser API as a method of window in production.
  const opener = openWindow ?? ((url: string, target: string, features: string) => window.open(url, target, features));
  opener(applicationUrl, "_blank", "noopener,noreferrer");
  return true;
}
