import { NextResponse } from "next/server";
import { generateBulletLibrary } from "@/lib/documents/bulletLibrary";
import { withUser } from "@/lib/auth/session";

export const POST = withUser(async (_request, user) => {
  try {
    const result = await generateBulletLibrary(user.id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not generate the bullet library." },
      { status: 400 },
    );
  }
});
