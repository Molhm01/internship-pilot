import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { loadFullProfile, profileGaps } from "@/lib/profile/service";

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const profile = await loadFullProfile(user.id);
  return NextResponse.json(
    { ...profile, gaps: profileGaps(profile) },
    { headers: { "cache-control": "no-store" } },
  );
}
