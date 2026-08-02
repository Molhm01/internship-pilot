// Location geofilter for Local Firms. Origin is Clifton, NJ; default radius is
// 50 miles. A firm is "local" ONLY when a real computed Haversine distance
// (miles) is within the radius. Missing/unresolvable coordinates are placed in
// "Location Unknown" and excluded from the default local list — never treated
// as distance zero. This is why California firms must not appear as local.

export const CLIFTON_NJ = { lat: 40.8584, lng: -74.1638 };
export const DEFAULT_RADIUS_MILES = 50;

export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(3958.8 * 2 * Math.asin(Math.sqrt(h)) * 10) / 10;
}

// City-level coordinates for the NJ / NYC metro + a few far cities used to
// prove exclusion. "City, ST" keys are matched case-insensitively.
const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  "clifton,nj": { lat: 40.8584, lng: -74.1638 },
  "newark,nj": { lat: 40.7357, lng: -74.1724 },
  "jersey city,nj": { lat: 40.7178, lng: -74.0431 },
  "hoboken,nj": { lat: 40.7439, lng: -74.0324 },
  "parsippany,nj": { lat: 40.8578, lng: -74.426 },
  "paterson,nj": { lat: 40.9168, lng: -74.1718 },
  "montclair,nj": { lat: 40.8259, lng: -74.209 },
  "morristown,nj": { lat: 40.7968, lng: -74.4815 },
  "edison,nj": { lat: 40.5187, lng: -74.4121 },
  "princeton,nj": { lat: 40.3573, lng: -74.6672 },
  "trenton,nj": { lat: 40.2171, lng: -74.7429 },
  "new york,ny": { lat: 40.7128, lng: -74.006 },
  "new york city,ny": { lat: 40.7128, lng: -74.006 },
  "brooklyn,ny": { lat: 40.6782, lng: -73.9442 },
  "white plains,ny": { lat: 41.034, lng: -73.7629 },
  "yonkers,ny": { lat: 40.9312, lng: -73.8988 },
  "stamford,ct": { lat: 41.0534, lng: -73.5387 },
  "philadelphia,pa": { lat: 39.9526, lng: -75.1652 },
  "los angeles,ca": { lat: 34.0522, lng: -118.2437 },
  "san francisco,ca": { lat: 37.7749, lng: -122.4194 },
  "san jose,ca": { lat: 37.3382, lng: -121.8863 },
  "seattle,wa": { lat: 47.6062, lng: -122.3321 },
  "austin,tx": { lat: 30.2672, lng: -97.7431 },
  "boston,ma": { lat: 42.3601, lng: -71.0589 },
};

// State centroids — a coarse fallback when only "…, ST" is known (no city
// match). Enough to correctly place a firm inside/outside a metro radius:
// distant states resolve far away and are excluded.
const STATE_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  nj: { lat: 40.0583, lng: -74.4057 },
  ny: { lat: 42.9, lng: -75.5 },
  ct: { lat: 41.6032, lng: -73.0877 },
  pa: { lat: 40.9, lng: -77.8 },
  ca: { lat: 36.7783, lng: -119.4179 },
  wa: { lat: 47.7511, lng: -120.7401 },
  tx: { lat: 31.9686, lng: -99.9018 },
  ma: { lat: 42.4072, lng: -71.3824 },
  fl: { lat: 27.6648, lng: -81.5158 },
};

const STATE_ABBR: Record<string, string> = {
  "new jersey": "nj", "new york": "ny", connecticut: "ct", pennsylvania: "pa",
  california: "ca", washington: "wa", texas: "tx", massachusetts: "ma", florida: "fl",
};

function normCity(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// Parse a free-text location into "city" + 2-letter "state" when possible.
export function parseLocation(location: string): { city: string | null; state: string | null } {
  const cleaned = location.replace(/,?\s*(united states|usa|u\.s\.a\.|us)\.?$/i, "").trim();
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { city: null, state: null };
  let state: string | null = null;
  let city: string | null = null;
  const last = parts[parts.length - 1];
  const lastToken = last.split(/\s+/).pop() ?? "";
  if (/^[A-Za-z]{2}$/.test(lastToken)) state = lastToken.toLowerCase();
  else if (STATE_ABBR[last.toLowerCase()]) state = STATE_ABBR[last.toLowerCase()];
  if (parts.length >= 2) city = parts[0];
  else if (state && parts.length === 1) city = null;
  else city = parts[0];
  return { city: city ? normCity(city) : null, state };
}

export type Resolution = { coords: { lat: number; lng: number } | null; precision: "city" | "state" | "none" };

// Resolve coordinates from a location string. Remote/empty → none.
export function resolveCoordinates(location: string | null | undefined): Resolution {
  if (!location || /\bremote\b/i.test(location)) return { coords: null, precision: "none" };
  const { city, state } = parseLocation(location);
  if (city && state) {
    const hit = CITY_COORDS[`${city},${state}`];
    if (hit) return { coords: hit, precision: "city" };
  }
  if (city && !state) {
    // Try any state for a unique city name.
    const match = Object.entries(CITY_COORDS).find(([k]) => k.startsWith(`${city},`));
    if (match) return { coords: match[1], precision: "city" };
  }
  if (state && STATE_CENTROIDS[state]) return { coords: STATE_CENTROIDS[state], precision: "state" };
  return { coords: null, precision: "none" };
}

export type LocationBucket = "local" | "outside" | "unknown";

export type LocationClassification = {
  bucket: LocationBucket;
  distanceMiles: number | null;
  precision: "city" | "state" | "none" | "remote";
};

// Classify a firm location against the configured origin + radius.
//  - A remote posting is "local" (works from Clifton) with a null distance.
//  - A resolvable location within radius → "local" with the computed distance.
//  - Resolvable but beyond radius → "outside".
//  - Unresolvable coordinates → "unknown" (never counted as local).
// `storedDistanceMiles` (a previously computed exact distance) is trusted first.
export function classifyLocation(
  location: string | null | undefined,
  radiusMiles: number = DEFAULT_RADIUS_MILES,
  storedDistanceMiles: number | null = null,
): LocationClassification {
  if (location && /\bremote\b/i.test(location)) return { bucket: "local", distanceMiles: null, precision: "remote" };
  if (storedDistanceMiles != null && Number.isFinite(storedDistanceMiles)) {
    return { bucket: storedDistanceMiles <= radiusMiles ? "local" : "outside", distanceMiles: Math.round(storedDistanceMiles * 10) / 10, precision: "city" };
  }
  const { coords, precision } = resolveCoordinates(location);
  if (!coords) return { bucket: "unknown", distanceMiles: null, precision: "none" };
  const distanceMiles = haversineMiles(CLIFTON_NJ, coords);
  return { bucket: distanceMiles <= radiusMiles ? "local" : "outside", distanceMiles, precision };
}
