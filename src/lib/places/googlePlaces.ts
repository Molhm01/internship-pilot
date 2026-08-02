// Google Places API integration — official API only, never scrapes
// maps.google.com. Fully optional: without GOOGLE_PLACES_API_KEY configured,
// every function here simply returns null/empty rather than erroring.

export const CLIFTON_NJ = { lat: 40.8584, lng: -74.1638 };

export function getGooglePlacesApiKey(): string | null {
  return process.env.GOOGLE_PLACES_API_KEY || null;
}

export type PlaceResult = {
  placeId: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
};

const MILES_TO_METERS = 1609.34;
export function milesToMeters(miles: number): number {
  return Math.round(miles * MILES_TO_METERS);
}

// Official Places API Text Search — the sanctioned way to query "kind of
// business near a location" without touching maps.google.com at all.
export async function searchPlacesText(
  query: string,
  center: { lat: number; lng: number },
  radiusMiles: number,
  apiKey: string,
): Promise<PlaceResult[]> {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
    query,
  )}&location=${center.lat},${center.lng}&radius=${milesToMeters(radiusMiles)}&key=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      status: string;
      results?: Array<{
        place_id: string;
        name: string;
        formatted_address?: string;
        geometry?: { location?: { lat: number; lng: number } };
      }>;
    };
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return [];
    return (data.results ?? []).map((r) => ({
      placeId: r.place_id,
      name: r.name,
      address: r.formatted_address ?? null,
      latitude: r.geometry?.location?.lat ?? null,
      longitude: r.geometry?.location?.lng ?? null,
    }));
  } catch {
    return [];
  }
}

// Place Details — fetches the official website Google has on file for a
// specific place, used as the starting point for our own independent
// confirmation (never trusted blindly as "the internship page").
export async function getPlaceWebsite(placeId: string, apiKey: string): Promise<string | null> {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=website&key=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { website?: string } };
    return data.result?.website ?? null;
  } catch {
    return null;
  }
}

export async function geocodeAddress(address: string, apiKey: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }> };
    const loc = data.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch {
    return null;
  }
}

export const FIRM_CATEGORIES = [
  { key: "electrical", label: "Electrical engineering firms", query: "electrical engineering firm" },
  { key: "electronics", label: "Electronics companies", query: "electronics company" },
  { key: "aerospace", label: "Aerospace and defense contractors", query: "aerospace defense contractor" },
  { key: "semiconductor", label: "Semiconductor companies", query: "semiconductor company" },
  { key: "automation", label: "Industrial automation companies", query: "industrial automation company" },
  { key: "robotics", label: "Robotics companies", query: "robotics company" },
  { key: "telecom", label: "Telecommunications engineering companies", query: "telecommunications engineering company" },
  { key: "utilities", label: "Utilities", query: "electric utility company" },
  { key: "medtech", label: "Medical-device engineering companies", query: "medical device engineering company" },
  { key: "hardwareStartup", label: "Hardware startups", query: "hardware startup" },
  { key: "consulting", label: "Engineering consulting firms", query: "engineering consulting firm" },
  { key: "manufacturing", label: "Manufacturing (electrical/controls)", query: "electrical controls manufacturing company" },
] as const;
