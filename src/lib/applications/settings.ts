import { prisma } from "@/lib/db";
import type { ApplicationMode } from "./types";

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

export async function getApplicationSettings(): Promise<ApplicationSettings> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [MODE_KEY, THRESHOLD_KEY, ALLOWLIST_KEY, KEEP_FAILED_OPEN_KEY] } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  const rawMode = byKey.get(MODE_KEY);
  const parsedMode = rawMode ? (JSON.parse(rawMode) as string) : "FILL_TO_SUBMIT";
  const mode: ApplicationMode = parsedMode === "OFF" ? "OFF" : "FILL_TO_SUBMIT";

  const rawThreshold = byKey.get(THRESHOLD_KEY);
  const parsedThreshold = rawThreshold ? Number(JSON.parse(rawThreshold)) : DEFAULT_THRESHOLD;
  const autoSubmitThreshold = Number.isFinite(parsedThreshold) ? Math.min(100, Math.max(0, parsedThreshold)) : DEFAULT_THRESHOLD;

  const rawAllowlist = byKey.get(ALLOWLIST_KEY);
  let autoSubmitAllowlist: string[] = [];
  if (rawAllowlist) {
    try {
      const parsed = JSON.parse(rawAllowlist);
      if (Array.isArray(parsed)) autoSubmitAllowlist = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      autoSubmitAllowlist = [];
    }
  }

  const rawKeepOpen = byKey.get(KEEP_FAILED_OPEN_KEY);
  const keepFailedApplicationOpen = rawKeepOpen ? Boolean(JSON.parse(rawKeepOpen)) : true;

  return { mode, autoSubmitThreshold, autoSubmitAllowlist, keepFailedApplicationOpen };
}

export async function setKeepFailedApplicationOpen(open: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: KEEP_FAILED_OPEN_KEY },
    update: { value: JSON.stringify(open) },
    create: { key: KEEP_FAILED_OPEN_KEY, value: JSON.stringify(open) },
  });
}

export async function setApplicationMode(mode: ApplicationMode): Promise<void> {
  const safeMode: ApplicationMode = mode === "OFF" ? "OFF" : "FILL_TO_SUBMIT";
  await prisma.appSetting.upsert({
    where: { key: MODE_KEY },
    update: { value: JSON.stringify(safeMode) },
    create: { key: MODE_KEY, value: JSON.stringify(safeMode) },
  });
}

export async function setAutoSubmitThreshold(threshold: number): Promise<void> {
  const clamped = Math.min(100, Math.max(0, Math.round(threshold)));
  await prisma.appSetting.upsert({
    where: { key: THRESHOLD_KEY },
    update: { value: JSON.stringify(clamped) },
    create: { key: THRESHOLD_KEY, value: JSON.stringify(clamped) },
  });
}

export async function setAutoSubmitAllowlist(companies: string[]): Promise<void> {
  const cleaned = Array.from(new Set(companies.map((c) => c.trim()).filter(Boolean)));
  await prisma.appSetting.upsert({
    where: { key: ALLOWLIST_KEY },
    update: { value: JSON.stringify(cleaned) },
    create: { key: ALLOWLIST_KEY, value: JSON.stringify(cleaned) },
  });
}

export function isCompanyAllowlisted(company: string, allowlist: string[]): boolean {
  const target = company.trim().toLowerCase();
  return allowlist.some((c) => c.trim().toLowerCase() === target);
}
