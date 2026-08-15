import { readUserSettings, writeUserSetting } from "@/lib/userSettings";
import type { ApplicationMode } from "./types";

/**
 * Application-agent settings, per user.
 *
 * These were rows in the global `AppSetting` table: one application mode, one
 * auto-submit threshold, one allowlist for the whole installation. Hosted, that
 * means one person switching the agent off switches it off for everybody, and
 * one person's allowlist authorizes everybody's runs. They are per user now.
 *
 * The defaults are unchanged, and deliberately conservative: fill, never
 * submit; an empty allowlist; keep a failed application's tab open.
 */

const MODE_KEY = "applicationMode";
const THRESHOLD_KEY = "applicationAutoSubmitThreshold";
const ALLOWLIST_KEY = "applicationAutoSubmitAllowlist";
const KEEP_FAILED_OPEN_KEY = "keepFailedApplicationOpen";

const DEFAULT_THRESHOLD = 75;

export interface ApplicationSettings {
  mode: ApplicationMode;
  autoSubmitThreshold: number;
  autoSubmitAllowlist: string[]; // company names, exact match, case-insensitive
  keepFailedApplicationOpen: boolean;
}

export async function getApplicationSettings(userId: string): Promise<ApplicationSettings> {
  const values = await readUserSettings(userId, [
    MODE_KEY,
    THRESHOLD_KEY,
    ALLOWLIST_KEY,
    KEEP_FAILED_OPEN_KEY,
  ]);

  const rawMode = values.get(MODE_KEY);
  const mode: ApplicationMode = rawMode === "OFF" ? "OFF" : "FILL_TO_SUBMIT";

  const rawThreshold = Number(values.get(THRESHOLD_KEY) ?? DEFAULT_THRESHOLD);
  const autoSubmitThreshold = Number.isFinite(rawThreshold)
    ? Math.min(100, Math.max(0, rawThreshold))
    : DEFAULT_THRESHOLD;

  const rawAllowlist = values.get(ALLOWLIST_KEY);
  const autoSubmitAllowlist = Array.isArray(rawAllowlist)
    ? rawAllowlist.filter((entry): entry is string => typeof entry === "string")
    : [];

  const rawKeepOpen = values.get(KEEP_FAILED_OPEN_KEY);
  const keepFailedApplicationOpen = typeof rawKeepOpen === "boolean" ? rawKeepOpen : true;

  return { mode, autoSubmitThreshold, autoSubmitAllowlist, keepFailedApplicationOpen };
}

export async function setKeepFailedApplicationOpen(userId: string, open: boolean): Promise<void> {
  await writeUserSetting(userId, KEEP_FAILED_OPEN_KEY, open);
}

export async function setApplicationMode(userId: string, mode: ApplicationMode): Promise<void> {
  await writeUserSetting(userId, MODE_KEY, mode === "OFF" ? "OFF" : "FILL_TO_SUBMIT");
}

export async function setAutoSubmitThreshold(userId: string, threshold: number): Promise<void> {
  await writeUserSetting(userId, THRESHOLD_KEY, Math.min(100, Math.max(0, Math.round(threshold))));
}

export async function setAutoSubmitAllowlist(userId: string, companies: string[]): Promise<void> {
  const cleaned = Array.from(new Set(companies.map((c) => c.trim()).filter(Boolean)));
  await writeUserSetting(userId, ALLOWLIST_KEY, cleaned);
}

export function isCompanyAllowlisted(company: string, allowlist: string[]): boolean {
  const target = company.trim().toLowerCase();
  return allowlist.some((c) => c.trim().toLowerCase() === target);
}
