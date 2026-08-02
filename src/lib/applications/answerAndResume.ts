import { prisma } from "@/lib/db";
import { normalizeQuestionText, saveApprovedAnswer } from "./approvedAnswers";
import { classifyField } from "./answerBank";
import { queueAnsweredRun } from "./queue";

export async function answerAndResumeApplicationRun(id: string, answer: string, reuseRequested: boolean) {
  const run = await prisma.applicationRun.findUnique({ where: { id } });
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
    await prisma.applicationProfile.upsert({ where: { id: "default" }, create: { id: "default", countryOfResidence: answer }, update: { countryOfResidence: answer } });
  } else if (reuse) {
    await saveApprovedAnswer(run.stoppedFieldLabel, answer);
  }
  await prisma.applicationRun.update({ where: { id }, data: { answers: JSON.stringify(answers) } });
  const result = await queueAnsweredRun(id);
  return { saved: true, reused: reuse, questionText: run.stoppedFieldLabel, ...result };
}
