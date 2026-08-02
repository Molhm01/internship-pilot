import { NextResponse } from "next/server";
import { CLIFTON_NJ } from "@/lib/places/googlePlaces";
import { getNearbySearchPreference, setNearbySearchPreference } from "@/lib/sync/nearbyDiscovery";
export async function GET(){return NextResponse.json({preference:await getNearbySearchPreference(),sourcePolicy:"approved-csv-and-verified-intern-list-only"})}
export async function POST(req:Request){const body=await req.json().catch(()=>null);const radiusMiles=Number(body?.radiusMiles);if(![25,50,100,150].includes(radiusMiles))return NextResponse.json({error:"A valid radiusMiles (25/50/100/150) is required."},{status:400});const pref={centerAddress:"Clifton, NJ",lat:CLIFTON_NJ.lat,lng:CLIFTON_NJ.lng,radiusMiles};await setNearbySearchPreference(pref);return NextResponse.json({preference:pref})}
