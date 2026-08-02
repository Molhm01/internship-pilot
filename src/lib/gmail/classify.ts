import { z } from "zod";
import { ollamaGenerateJSON } from "@/lib/ollama";

export const EMAIL_CLASSIFICATIONS = [
  "confirmation",
  "assessment",
  "interview",
  "recruiter-message",
  "info-request",
  "rejection",
  "offer",
  "withdrawal",
  "status-update",
  "unknown",
] as const;
export type EmailClassification = (typeof EMAIL_CLASSIFICATIONS)[number];

const classificationSchema = z.object({
  classification: z.enum(EMAIL_CLASSIFICATIONS),
  company: z.string().trim().nullable(),
  jobTitle: z.string().trim().nullable(),
  assessment: z
    .object({
      provider: z.string().trim().nullable(),
      deadline: z.string().trim().nullable(),
      duration: z.string().trim().nullable(),
      link: z.string().trim().nullable(),
      instructions: z.string().trim().nullable(),
    })
    .nullable(),
});
export type EmailClassificationResult = z.infer<typeof classificationSchema>;

export type EmailToClassify = {
  subject: string;
  fromAddress: string;
  bodyText: string;
};

function buildPrompt(email: EmailToClassify): string {
  return `You are classifying a single email related to a student's internship applications. Read ONLY what is written below — never invent a deadline, provider name, duration, or link that isn't explicitly present in the text.

Classify into exactly one category:
- confirmation: acknowledges an application was received
- assessment: asks the candidate to complete a coding/skills test or assessment
- interview: schedules or discusses an interview
- recruiter-message: a recruiter reaching out, not clearly one of the above
- info-request: asks the candidate to provide more information/documents
- rejection: declines the candidate
- offer: extends a job/internship offer
- withdrawal: candidate's own withdrawal being acknowledged
- status-update: a generic status change not covered above
- unknown: doesn't clearly fit any category

FROM: ${email.fromAddress}
SUBJECT: ${email.subject}
BODY:
"""
${email.bodyText.slice(0, 6000)}
"""

If classification is "assessment", also extract (all optional, use null if not explicitly stated — never guess):
- provider (e.g. HackerRank, Codility, CodeSignal, Criteria Corp)
- deadline (copy the exact text as written, e.g. "by Friday, March 5th" — do not compute a date)
- duration (e.g. "90 minutes", "2 hours")
- link (the assessment URL, if present)
- instructions (a short summary of what the candidate needs to do)

Also extract the company name and job title if mentioned anywhere in the email (null if not clear).

Return ONLY valid JSON, no commentary, no markdown fences:
{
  "classification": "one of the categories above",
  "company": "string or null",
  "jobTitle": "string or null",
  "assessment": { "provider": "string or null", "deadline": "string or null", "duration": "string or null", "link": "string or null", "instructions": "string or null" } (or null if classification is not "assessment")
}`;
}

export async function classifyEmail(email: EmailToClassify): Promise<EmailClassificationResult> {
  const raw = await ollamaGenerateJSON(buildPrompt(email), { timeoutMs: 120_000 });
  const parsed = classificationSchema.safeParse(raw);
  if (!parsed.success) {
    return { classification: "unknown", company: null, jobTitle: null, assessment: null };
  }
  return parsed.data;
}
