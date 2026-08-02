import "dotenv/config";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  getOllamaVersion,
  ollamaNativeChat,
  OllamaError,
  OLLAMA_CHAT_ENDPOINT,
  OLLAMA_MODEL,
  OLLAMA_VISION_MODEL,
  type OllamaImageMetadata,
} from "@/lib/ollama";
import {
  browserPlannerResponseSchema,
  BROWSER_PLANNER_JSON_SCHEMA,
} from "@/lib/applications/browserAgent";

type TestReport = {
  httpStatus: number | null;
  validContent: boolean;
  structuredOutputEnabled: boolean;
  structuredOutputFormat: "none" | "json" | "json_schema";
  parsedResponse: unknown;
  responseBody: string;
  error: string | null;
};

async function runTest(
  options: Parameters<typeof ollamaNativeChat>[0],
  parse: (content: string) => unknown,
): Promise<TestReport> {
  try {
    const result = await ollamaNativeChat(options);
    try {
      const parsedResponse = parse(result.content);
      return {
        httpStatus: result.metadata.httpStatus,
        validContent: true,
        structuredOutputEnabled: result.metadata.structuredOutputEnabled,
        structuredOutputFormat: result.metadata.structuredOutputFormat,
        parsedResponse,
        responseBody: result.responseBody,
        error: null,
      };
    } catch (error) {
      return {
        httpStatus: result.metadata.httpStatus,
        validContent: false,
        structuredOutputEnabled: result.metadata.structuredOutputEnabled,
        structuredOutputFormat: result.metadata.structuredOutputFormat,
        parsedResponse: null,
        responseBody: result.responseBody,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    const metadata = error instanceof OllamaError ? error.metadata : undefined;
    return {
      httpStatus: metadata?.httpStatus ?? null,
      validContent: false,
      structuredOutputEnabled: metadata?.structuredOutputEnabled ?? options.format !== undefined,
      structuredOutputFormat: metadata?.structuredOutputFormat ?? (options.format === undefined ? "none" : options.format === "json" ? "json" : "json_schema"),
      parsedResponse: null,
      responseBody: metadata?.responseBody ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
const outputDirectory = path.join(process.cwd(), "data", "generated", "diagnostics");
const screenshotPath = path.join(outputDirectory, "ollama-vision-preflight.jpg");
await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
let screenshot: Buffer;
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  await page.setContent(`
    <!doctype html>
    <html><body style="font-family:Arial;padding:48px;background:#f8fafc;color:#172033">
      <main style="max-width:720px;margin:auto;background:white;border:1px solid #ccd5e1;border-radius:12px;padding:32px">
        <h1>Application preflight</h1>
        <label>Full name <input aria-label="Full name" style="display:block;width:100%;margin:8px 0 20px;padding:10px"></label>
        <label>Email <input type="email" aria-label="Email" style="display:block;width:100%;margin:8px 0 20px;padding:10px"></label>
        <p>This synthetic page contains no personal data and cannot submit anything.</p>
      </main>
    </body></html>
  `);
  screenshot = await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 75, fullPage: false });
} finally {
  await browser.close();
}

const image: OllamaImageMetadata = {
  width: 960,
  height: 640,
  byteSize: screenshot.byteLength,
  format: "jpeg",
  quality: 75,
};
const imageBase64 = screenshot.toString("base64");
const common = { model: OLLAMA_VISION_MODEL, timeoutMs: 120_000, temperature: 0 };

const textOnly = await runTest(
  {
    ...common,
    prompt: "Reply with the exact plain text: OLLAMA_TEXT_OK",
  },
  (content) => z.string().min(1).parse(content.trim()),
);
const imageNoStructured = await runTest(
  {
    ...common,
    prompt: "Inspect this screenshot. In one short sentence, name one visible form field.",
    imageBase64,
    imageMetadata: image,
  },
  (content) => z.string().min(1).parse(content.trim()),
);
const imageJson = await runTest(
  {
    ...common,
    prompt: 'Inspect this screenshot and return only JSON: {"pageType":"application","visibleFields":["Full name","Email"]}.',
    imageBase64,
    imageMetadata: image,
    format: "json",
  },
  (content) => z.object({
    pageType: z.string().min(1),
    visibleFields: z.array(z.string().min(1)).min(1),
  }).passthrough().parse(JSON.parse(content)),
);
const imageActionSchema = await runTest(
  {
    ...common,
    prompt: 'Inspect this safe synthetic form and return one continue action. Never return a Submit click.',
    imageBase64,
    imageMetadata: image,
    format: BROWSER_PLANNER_JSON_SCHEMA,
  },
  (content) => browserPlannerResponseSchema.parse(JSON.parse(content)),
);

const schemaSupported = imageActionSchema.httpStatus === 200 && imageActionSchema.validContent;
const report = {
  pass: textOnly.httpStatus === 200
    && textOnly.validContent
    && imageNoStructured.httpStatus === 200
    && imageNoStructured.validContent
    && imageJson.httpStatus === 200
    && imageJson.validContent,
  testedAt: new Date().toISOString(),
  ollamaVersion: await getOllamaVersion(),
  model: OLLAMA_VISION_MODEL,
  textModel: OLLAMA_MODEL,
  endpoint: OLLAMA_CHAT_ENDPOINT,
  image,
  screenshotPath,
  imageBase64Logged: false,
  tests: { textOnly, imageNoStructured, imageJson, imageActionSchema },
  schemaSupported,
  productionStructuredOutput: schemaSupported ? "json_schema supported; production still uses format json plus local Zod validation" : "format json plus local Zod validation",
};

await prisma.appSetting.upsert({
  where: { key: "ollamaVisionPreflight" },
  create: { key: "ollamaVisionPreflight", value: JSON.stringify(report) },
  update: { value: JSON.stringify(report) },
});
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
if (!report.pass) process.exitCode = 1;
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
