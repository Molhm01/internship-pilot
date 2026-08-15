import { NextResponse } from "next/server";
import {
  getApplicationSettings,
  setApplicationMode,
  setAutoSubmitThreshold,
  setAutoSubmitAllowlist,
} from "@/lib/applications/settings";
import type { ApplicationMode } from "@/lib/applications/types";
import { withUser } from "@/lib/auth/session";

const VALID_MODES: ApplicationMode[] = ["OFF", "FILL_TO_SUBMIT"];

/** The caller's own agent settings. These used to be installation-wide. */
export const GET = withUser(async (_request, user) => {
  const settings = await getApplicationSettings(user.id);
  return NextResponse.json(settings);
});

export const POST = withUser(async (req, user) => {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  if (body.mode !== undefined) {
    if (!VALID_MODES.includes(body.mode)) {
      return NextResponse.json({ error: `Invalid mode: ${body.mode}` }, { status: 400 });
    }
    await setApplicationMode(user.id, body.mode);
  }
  if (body.autoSubmitThreshold !== undefined) {
    const n = Number(body.autoSubmitThreshold);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return NextResponse.json({ error: "Threshold must be a number between 0 and 100." }, { status: 400 });
    }
    await setAutoSubmitThreshold(user.id, n);
  }
  if (body.autoSubmitAllowlist !== undefined) {
    if (!Array.isArray(body.autoSubmitAllowlist) || !body.autoSubmitAllowlist.every((c: unknown) => typeof c === "string")) {
      return NextResponse.json({ error: "Allowlist must be an array of company name strings." }, { status: 400 });
    }
    await setAutoSubmitAllowlist(user.id, body.autoSubmitAllowlist);
  }

  const settings = await getApplicationSettings(user.id);
  return NextResponse.json(settings);
});
