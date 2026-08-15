import { NextResponse } from "next/server";
import { CLIFTON_NJ } from "@/lib/places/googlePlaces";
import { getNearbySearchPreference, setNearbySearchPreference } from "@/lib/sync/nearbyDiscovery";
import { withUser } from "@/lib/auth/session";

/** Where this user searches from. One preference per account. */
export const GET = withUser(async (_request, user) =>
  NextResponse.json({
    preference: await getNearbySearchPreference(user.id),
    sourcePolicy: "approved-csv-and-verified-intern-list-only",
  }),
);

export const POST = withUser(async (req, user) => {
  const body = await req.json().catch(() => null);
  const radiusMiles = Number(body?.radiusMiles);
  if (![25, 50, 100, 150].includes(radiusMiles)) {
    return NextResponse.json(
      { error: "A valid radiusMiles (25/50/100/150) is required." },
      { status: 400 },
    );
  }
  const preference = {
    centerAddress: "Clifton, NJ",
    lat: CLIFTON_NJ.lat,
    lng: CLIFTON_NJ.lng,
    radiusMiles,
  };
  await setNearbySearchPreference(user.id, preference);
  return NextResponse.json({ preference });
});
