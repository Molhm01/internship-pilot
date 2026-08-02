// Common shape every ATS adapter normalizes into, regardless of source.
export type AtsJob = {
  sourceJobId: string;
  requisitionId?: string | null;
  title: string;
  company: string;
  location: string | null;
  workplaceType: string | null; // Remote | Hybrid | On Site | null (unknown)
  applyUrl: string;
  description: string;
  postedAt: Date | null;
  /**
   * The vendor's own posting-date wording when it exposes text instead of a
   * timestamp (Workday's "Posted Today" / "Posted 30+ Days Ago"). Resolved
   * against the sync's capture time by src/lib/sync/sourceDate.ts.
   */
  postedAtText?: string | null;
  /** Vendor-reported employment type ("Intern", "FullTime", ...) when exposed. */
  employmentType?: string | null;
};

export type AtsType =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workday"
  | "icims"
  | "taleo"
  | "successfactors"
  | "usajobs"
  | "custom"
  | "unknown";

export async function fetchJsonSafe(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
