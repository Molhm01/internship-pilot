import { NextResponse } from "next/server";
import { generateBulletLibrary } from "@/lib/documents/bulletLibrary";

export async function POST() {
  try {
    const result = await generateBulletLibrary();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not generate the bullet library." },
      { status: 400 },
    );
  }
}
