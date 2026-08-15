import { prisma } from "@/lib/db";
import { normalizeQuestionText, saveApprovedAnswer } from "./approvedAnswers";
import { classifyField } from "./answerBank";
import { queueAnsweredRun } from "./queue";

export async function answerAndResumeApplicationRun(
  id: string,
  answer: string,
  reuseRequested: boolean,
  userId: string,
) {
  const run = await prisma.applicationRun.findFirst({ where: { id, userId } });
  if (!run || run.status !== "needs_user_action" || !run.stoppedFieldLabel) {
    throw new Error("This run has no pending question to answer.");
  }
  const category = classifyField(run.stoppedFieldLabel);
  const reuse = reuseRequested;
  const normalized = normalizeQuestionText(run.stoppedFieldLabel);
  let answers: Record<string, string> = {};
  try { answers = JSON.parse(run.answers ?? "{}"); } catch { answers = {}; }
  answers[normalized] = answer;

  if (reuse && category === "country") {
    // Country of residence is part of the applicant's own profile, so it is
    // saved there rather than to a shared row.
    await prisma.userProfile.upsert({
      where: { userId },
      create: { userId, country: answer },
      update: { country: answer },
    });
  } else if (reuse) {
    await saveApprovedAnswer(run.stoppedFieldLabel, answer, userId);
  }
  await prisma.applicationRun.update({ where: { id: run.id }, data: { answers: JSON.stringify(answers) } });
  const result = await queueAnsweredRun(id, userId);
  return { saved: true, reused: reuse, questionText: run.stoppedFieldLabel, ...result };
}
