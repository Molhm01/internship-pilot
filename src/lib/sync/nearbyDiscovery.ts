import { readUserSetting, writeUserSetting } from "@/lib/userSettings";
import { CLIFTON_NJ } from "@/lib/places/googlePlaces";
import { buildLocalFirms } from "@/lib/localFirms";

export type NearbySearchPreference = { centerAddress:string; lat:number; lng:number; radiusMiles:number };
const SETTING_KEY="nearbySearch";
const DEFAULT_PREFERENCE: NearbySearchPreference = {
  centerAddress: "Clifton, NJ",
  lat: CLIFTON_NJ.lat,
  lng: CLIFTON_NJ.lng,
  radiusMiles: 50,
};

/**
 * Where this user searches from, and how far.
 *
 * A preference, not installation configuration: it was one global
 * `AppSetting` row, so one person changing their radius changed everybody's.
 * The scheduler, which has no user, uses the default below.
 */
export async function getNearbySearchPreference(userId: string): Promise<NearbySearchPreference> {
  return readUserSetting<NearbySearchPreference>(userId, SETTING_KEY, DEFAULT_PREFERENCE);
}
export async function setNearbySearchPreference(userId: string, pref: NearbySearchPreference) {
  await writeUserSetting(userId, SETTING_KEY, pref);
}
export type NearbySearchSummary={configured:boolean;discovered:number;promoted:number};
// Compatibility wrapper retained for the scheduler. It no longer queries Google
// or directories; it rebuilds Local Firms from approved employers and exact
// LIVE_JOB_VERIFIED locations only.
export async function runNearbyFirmSearch(): Promise<NearbySearchSummary> {
  // Runs on the scheduler with nobody signed in. Local Firms is rebuilt from
  // approved employers and verified locations — shared data — so the default
  // radius is the right input here; a particular person's radius is not.
  const result = await buildLocalFirms(DEFAULT_PREFERENCE.radiusMiles);
  return { configured: true, discovered: result.firms.length, promoted: 0 };
}
