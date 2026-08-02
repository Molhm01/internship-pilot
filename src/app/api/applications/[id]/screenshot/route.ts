import path from "node:path";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await prisma.applicationRun.findUnique({ where: { id } });
  if (!run?.screenshotPath) return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });
  const root = path.resolve(/* turbopackIgnore: true */ process.cwd(), "data", "generated");
  const target = path.resolve(/* turbopackIgnore: true */ process.cwd(), run.screenshotPath);
  if (!target.startsWith(root + path.sep)) return NextResponse.json({ error: "Invalid screenshot path." }, { status: 400 });
  try {
    return new NextResponse(new Uint8Array(await readFile(target)), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });
  }
}
