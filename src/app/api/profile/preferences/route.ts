import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import {
  savePersonal,
  saveApplicationPreferences,
  saveSensitivePreferences,
} from "@/lib/profile/service";

const SAVERS = {
  personal: savePersonal,
  preferences: saveApplicationPreferences,
  sensitive: saveSensitivePreferences,
} as const;

export async function PUT(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  const saved = await SAVERS["preferences"](user.id, body);
  return NextResponse.json({ saved });
}
