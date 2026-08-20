import { createHash } from "node:crypto";
import { z } from "zod";
import { geminiGenerateJSON } from "@/lib/gemini";
import { ollamaGenerateJSON } from "@/lib/ollama";
import { isCloudRuntime } from "@/lib/runtime/deployment";
import { readUserSetting, writeUserSetting } from "@/lib/userSettings";
import {
  enqueueSupplementalRadarSignals,
  type SupplementalRadarSignal,
  type SupplementalRadarSource,
} from "@/lib/sync/supplementalRadarQueue";
import type { FetchedEmail } from "@/lib/gmail/client";

export const JOB_ALERT_PROVIDERS = [
  "linkedin",
  "handshake",
  "indeed",
  "glassdoor",
  "ziprecruiter",
] as const;
export type JobAlertProvider = (typeof JOB_ALERT_PROVIDERS)[number];

const providerStatusKey = "radar:job-alert-provider-status";

export type JobAlertProviderStatus = Record<
  JobAlertProvider,
  {
    detectedEmails: number;
    signalsExtracted: number;
    signalsEnqueued: number;
    lastSeenAt: string | null;
  }
>;

function emptyProviderStatus(): JobAlertProviderStatus {
  return Object.fromEntries(
    JOB_ALERT_PROVIDERS.map((provider) => [
      provider,
      { detectedEmails: 0, signalsExtracted: 0, signalsEnqueued: 0, lastSeenAt: null },
    ]),
  ) as JobAlertProviderStatus;
}

const ALERT_LANGUAGE = /\b(job alert|jobs? for you|new jobs?|recommended jobs?|job recommendations?|internships? for you|new matches?|matching jobs?|jobs? you may like)\b/i;

export function detectJobAlertProvider(email: {
  fromAddress: string;
  subject: string;
  bodyText: string;
}): JobAlertProvider | null {
  const sender = email.fromAddress.toLowerCase();
  const subject = email.subject.toLowerCase();
  const bodyLead = email.bodyText.slice(0, 1200).toLowerCase();
  const combined = `${sender}\n${subject}\n${bodyLead}`;

  let provider: JobAlertProvider | null = null;
  if (/linkedin\.com|linkedin/i.test(sender)) provider = "linkedin";
  else if (/joinhandshake\.com|handshake/i.test(sender)) provider = "handshake";
  else if (/indeed\./i.test(sender)) provider = "indeed";
  else if (/glassdoor\./i.test(sender)) provider = "glassdoor";
  else if (/ziprecruiter\./i.test(sender)) provider = "ziprecruiter";

  if (!provider) return null;
  return ALERT_LANGUAGE.test(`${subject}\n${bodyLead}`) || /alert|recommend/i.test(combined)
    ? provider
    : null;
}

const extractedSchema = z.object({
  jobs: z.array(z.object({
    title: z.string().trim().min(1),
    company: z.string().trim().min(1),
    location: z.string().trim().nullable(),
    sourceUrl: z.string().trim().nullable(),
  })).max(25),
});

type ExtractedAlert = z.infer<typeof extractedSchema>;

const extractedJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["jobs"],
  properties: {
    jobs: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "company", "location", "sourceUrl"],
        properties: {
          title: { type: "string" },
          company: { type: "string" },
          location: { type: ["string", "null"] },
          sourceUrl: { type: ["string", "null"] },
        },
      },
    },
  },
};

function extractionPrompt(provider: JobAlertProvider, email: FetchedEmail): string {
  return `Extract job-listing SIGNALS from this ${provider} job-alert email.

Rules:
- This is discovery only. Do not infer or invent anything.
- Return only jobs/internships explicitly named in the email.
- For every row, both title and company must be explicitly present. If either is unclear, skip it.
- Prefer engineering, software, hardware, electrical, computer, data, ML/AI, embedded, firmware, robotics, systems, manufacturing, mechanical, aerospace, semiconductor, test/validation, controls, power/energy and related technical internships/co-ops.
- Ignore navigation links, unsubscribe links, account/settings links, marketing copy and generic "view jobs" buttons.
- location is null if the email does not explicitly state it.
- sourceUrl is null unless an actual URL for that specific listing is literally present in the email text/HTML below. Never construct a URL.
- Maximum 25 jobs.

FROM: ${email.fromAddress}
SUBJECT: ${email.subject}
EMAIL:
"""
${email.bodyText.slice(0, 14_000)}
"""

Return only JSON matching the supplied schema.`;
}

function cleanSourceUrl(value: string | null, bodyText: string): string | null {
  if (!value) return null;
  const decoded = value.replace(/&amp;/g, "&").trim();
  if (!bodyText.includes(value) && !bodyText.includes(decoded)) return null;
  try {
    const url = new URL(decoded);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function extractAlert(provider: JobAlertProvider, email: FetchedEmail): Promise<ExtractedAlert> {
  const prompt = extractionPrompt(provider, email);
  const raw = isCloudRuntime()
    ? await geminiGenerateJSON(prompt, { schema: extractedJsonSchema, timeoutMs: 45_000 })
    : await ollamaGenerateJSON(prompt, {
        format: extractedJsonSchema,
        timeoutMs: 90_000,
        temperature: 0,
        numPredict: 1_600,
        numCtx: 12_000,
      });
  const parsed = extractedSchema.safeParse(raw);
  return parsed.success ? parsed.data : { jobs: [] };
}

function radarSource(provider: JobAlertProvider): SupplementalRadarSource {
  return `gmail-${provider}` as SupplementalRadarSource;
}

function signalId(provider: JobAlertProvider, emailId: string, title: string, company: string, index: number): string {
  const digest = createHash("sha256")
    .update(`${title}|${company}`.toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return `${provider}:${emailId}:${index}:${digest}`;
}

async function updateProviderStatus(
  userId: string,
  provider: JobAlertProvider,
  extracted: number,
  enqueued: number,
  seenAt: Date,
): Promise<void> {
  const status = await readUserSetting<JobAlertProviderStatus>(
    userId,
    providerStatusKey,
    emptyProviderStatus(),
  );
  const previous = status[provider] ?? emptyProviderStatus()[provider];
  status[provider] = {
    detectedEmails: previous.detectedEmails + 1,
    signalsExtracted: previous.signalsExtracted + extracted,
    signalsEnqueued: previous.signalsEnqueued + enqueued,
    lastSeenAt: seenAt.toISOString(),
  };
  await writeUserSetting(userId, providerStatusKey, status);
}

export async function readJobAlertProviderStatus(userId: string): Promise<JobAlertProviderStatus> {
  return readUserSetting<JobAlertProviderStatus>(
    userId,
    providerStatusKey,
    emptyProviderStatus(),
  );
}

/**
 * Turns a job-board alert email into untrusted radar signals. The email links
 * are never scraped as a catalogue. The supplemental queue independently
 * resolves title/company against the employer's official ATS before a Job can
 * enter Discover.
 */
export async function ingestJobAlertEmail(
  email: FetchedEmail,
  userId: string,
): Promise<{
  detected: boolean;
  provider: JobAlertProvider | null;
  extracted: number;
  enqueued: number;
}> {
  const provider = detectJobAlertProvider(email);
  if (!provider) return { detected: false, provider: null, extracted: 0, enqueued: 0 };

  let extracted: ExtractedAlert = { jobs: [] };
  try {
    extracted = await extractAlert(provider, email);
  } catch (error) {
    console.error("[job-alert-radar] extraction failed", {
      provider,
      errorCode: error instanceof Error ? error.name : "JOB_ALERT_EXTRACTION_FAILED",
    });
  }

  const source = radarSource(provider);
  const signals: SupplementalRadarSignal[] = extracted.jobs.map((job, index) => ({
    source,
    sourceJobId: signalId(provider, email.gmailMessageId, job.title, job.company, index),
    title: job.title,
    company: job.company,
    location: job.location || null,
    sourceUrl: cleanSourceUrl(job.sourceUrl, email.bodyText),
    // Email receipt time is only when Internship Pilot heard the signal. It is
    // deliberately NOT persisted as the employer's posting date; when the
    // official ATS resolves the role, its own timestamp wins instead.
    sourcePostedAt: null,
    sourcePostedText: null,
  }));
  const queued = await enqueueSupplementalRadarSignals(signals, email.receivedAt);
  await updateProviderStatus(userId, provider, signals.length, queued.enqueued, email.receivedAt);

  return {
    detected: true,
    provider,
    extracted: signals.length,
    enqueued: queued.enqueued,
  };
}