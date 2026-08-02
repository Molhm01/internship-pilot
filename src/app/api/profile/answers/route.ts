import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth/session";
import { text } from "@/lib/profile/service";

/** Saves one reusable answer. Upserted by question, so re-saving edits it. */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const questionText = text(body?.questionText);
  const answer = text(body?.answer);
  if (!questionText) {
    return NextResponse.json({ error: "A question is required.", field: "questionText" }, { status: 422 });
  }
  if (!answer) {
    return NextResponse.json({ error: "An answer is required.", field: "answer" }, { status: 422 });
  }
  const entry = await prisma.approvedAnswer.upsert({
    where: { userId_questionText: { userId: user.id, questionText } },
    update: { answer },
    create: { userId: user.id, questionText, answer },
  });
  return NextResponse.json({ entry }, { status: 201 });
}
