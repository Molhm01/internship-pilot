import "dotenv/config";
import { performance } from "node:perf_hooks";
import { buildCompactMatchPrompt, type FactForPrompt } from "../src/lib/prompts";
import { normalizeMatchDescription, selectRelevantApprovedFacts } from "../src/lib/matching/input";
import { ollamaGenerateJSON, type OllamaTiming } from "../src/lib/ollama";
import { matchResponseJsonSchema, matchResponseSchema } from "../src/lib/validation";

const fixtureFacts: FactForPrompt[] = [
  { id: "education-1", type: "education", content: "Computer Engineering student" },
  { id: "skill-python", type: "skill", content: "Python", detail: "Used in technical projects" },
  { id: "skill-c", type: "skill", content: "C", detail: "Used for embedded systems" },
  { id: "project-radio", type: "project", content: "Analyzed raw IQ data and implemented signal demodulation" },
  { id: "experience-repair", type: "experience", content: "Diagnosed hardware failures and completed more than 100 repairs" },
  { id: "experience-lead", type: "experience", content: "Coordinated peak-hour task assignments with coworkers" },
];

const fixtureJobs = [
  {
    title: "Embedded Systems Intern",
    company: "Fixture Electronics",
    description: "Develop and troubleshoot embedded C systems, analyze sensor measurements, document tests, and collaborate with engineers. Python experience is preferred.",
  },
  {
    title: "Test Engineering Intern",
    company: "Fixture Devices",
    description: "Diagnose hardware failures, execute verification procedures, analyze results, and communicate findings with a multidisciplinary team.",
  },
  {
    title: "Signal Processing Intern",
    company: "Fixture Radio",
    description: "Analyze sampled radio data, implement signal-processing algorithms in Python, debug results, and collaborate on technical documentation.",
  },
] as const;

type Measurement = {
  fixture: number;
  totalMs: number;
  modelGenerationMs: number;
  connectionMs: number;
  modelLoadMs: number;
  promptEvaluationMs: number;
  jsonParseMs: number;
  promptConstructionMs: number;
  validationMs: number;
  retries: number;
  ok: boolean;
  failureCode?: string;
};

async function measure(job: typeof fixtureJobs[number], fixture: number): Promise<Measurement> {
  const promptStartedAt = performance.now();
  const description = normalizeMatchDescription(job.description);
  const selectedFacts = selectRelevantApprovedFacts(fixtureFacts, `${job.title}\n${description}`);
  const prompt = buildCompactMatchPrompt(selectedFacts, { ...job, description });
  const promptConstructionMs = Math.round(performance.now() - promptStartedAt);
  const startedAt = performance.now();
  const timing: { value: OllamaTiming | null } = { value: null };
  let retries = 0;
  let failureCode: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await ollamaGenerateJSON(prompt, {
        timeoutMs: Number(process.env.AI_MATCH_MODEL_TIMEOUT_MS ?? 180_000),
        temperature: 0,
        format: matchResponseJsonSchema,
        keepAlive: process.env.AI_MATCH_KEEP_ALIVE ?? "10m",
        numPredict: Number(process.env.AI_MATCH_NUM_PREDICT ?? 1_200),
        numCtx: Number(process.env.AI_MATCH_CONTEXT_TOKENS ?? 8_192),
        onTiming: (value) => { timing.value = value; },
      });
      const validationStartedAt = performance.now();
      const validation = matchResponseSchema.safeParse(raw);
      const valid = validation.success;
      const validationMs = Math.round(performance.now() - validationStartedAt);
      if (!validation.success) {
        failureCode = `SCHEMA_INVALID:${Array.from(new Set(validation.error.issues.map((issue) => issue.path.join(".")))).join(",")}`;
      }
      if (!valid && attempt === 0) {
        retries += 1;
        continue;
      }
      return {
        fixture,
        totalMs: Math.round(performance.now() - startedAt),
        modelGenerationMs: timing.value?.modelGenerationMs ?? 0,
        connectionMs: timing.value?.connectionMs ?? 0,
        modelLoadMs: timing.value?.modelLoadMs ?? 0,
        promptEvaluationMs: timing.value?.promptEvaluationMs ?? 0,
        jsonParseMs: timing.value?.jsonParseMs ?? 0,
        promptConstructionMs,
        validationMs,
        retries,
        ok: valid,
        ...(valid ? {} : { failureCode }),
      };
    } catch (error) {
      failureCode = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "MODEL_REQUEST_FAILED";
      if (attempt === 0) {
        retries += 1;
        continue;
      }
    }
  }
  return {
    fixture,
    totalMs: Math.round(performance.now() - startedAt),
    modelGenerationMs: timing.value?.modelGenerationMs ?? 0,
    connectionMs: timing.value?.connectionMs ?? 0,
    modelLoadMs: timing.value?.modelLoadMs ?? 0,
    promptEvaluationMs: timing.value?.promptEvaluationMs ?? 0,
    jsonParseMs: timing.value?.jsonParseMs ?? 0,
    promptConstructionMs,
    validationMs: 0,
    retries,
    ok: false,
    failureCode,
  };
}

async function main() {
  const results: Measurement[] = [];
  let cursor = 0;
  const benchmarkStartedAt = performance.now();
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < fixtureJobs.length) {
      const fixture = cursor;
      cursor += 1;
      results.push(await measure(fixtureJobs[fixture], fixture + 1));
    }
  }));
  const wallClockMs = Math.round(performance.now() - benchmarkStartedAt);
  results.sort((a, b) => a.fixture - b.fixture);
  const average = (field: keyof Pick<Measurement,
    | "totalMs"
    | "modelGenerationMs"
    | "validationMs"
    | "connectionMs"
    | "modelLoadMs"
    | "promptEvaluationMs"
    | "jsonParseMs"
    | "promptConstructionMs"
  >) =>
    Math.round(results.reduce((sum, item) => sum + item[field], 0) / results.length);
  const successful = results.filter((item) => item.ok).length;
  console.log(JSON.stringify({
    fixtureCount: results.length,
    concurrency: 2,
    wallClockMs,
    averageTotalMs: average("totalMs"),
    averageModelGenerationMs: average("modelGenerationMs"),
    averageConnectionMs: average("connectionMs"),
    averageModelLoadMs: average("modelLoadMs"),
    averagePromptEvaluationMs: average("promptEvaluationMs"),
    averageJsonParseMs: average("jsonParseMs"),
    averagePromptConstructionMs: average("promptConstructionMs"),
    averageValidationMs: average("validationMs"),
    validationRetryCount: results.reduce((sum, item) => sum + item.retries, 0),
    successful,
    estimatedThroughputPerHour: Math.round((results.length * 3_600_000) / wallClockMs),
    estimatedSuccessfulThroughputPerHour: Math.round(
      (successful * 3_600_000) / wallClockMs,
    ),
    results,
  }));
}

void main();
