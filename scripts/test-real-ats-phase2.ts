import path from "node:path";
import { chromium } from "playwright";

const targets = [
  { name: "Greenhouse", url: "https://job-boards.greenhouse.io/freeformfuturecorp/jobs/7872198003" },
  { name: "Lever", url: "https://jobs.lever.co/palantir/ac0dc094-2480-43c2-8495-26ade227ff4f/apply" },
  { name: "Workday", url: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/NVIDIA-2027-Internships--Software-Engineering_JR2023495/apply" },
  { name: "Custom React (Ashby)", url: "https://jobs.ashbyhq.com/cohere/8c035d3d-081d-4c8a-914a-72f4efaad254/?action=apply" },
] as const;

type Reconnaissance = {
  url: string;
  title: string;
  fieldCount: number;
  requiredCount: number;
  categories: string[];
  fieldTypes: string[];
  labels: string[];
  blockers: Array<{ kind?: string; code?: string; detail?: string }>;
  nextAction: string | null;
  finalAction: string | null;
  bodyExcerpt: string;
  actionLabels: string[];
  fieldSummaries: Array<{ label: string; type: string; required: boolean; category: string; name: string; placeholder: string; section: string }>;
  enteredPersonalData: false;
  submitted: false;
};

async function inspect(page: import("playwright").Page, target: typeof targets[number]): Promise<Reconnaissance> {
  let navigationError: string | null = null;
  try {
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1_500);
    if (target.name.startsWith("Custom React")) {
      const applyButtons = page.getByRole("button", { name: /^apply for this job$/i });
      if (await applyButtons.count()) {
        await applyButtons.first().click();
        await page.waitForTimeout(1_500);
      }
    }
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }
  const result = await page.evaluate((errorMessage) => {
    const engine = (globalThis as typeof globalThis & {
      InternshipPilotAutofillEngine?: {
        scanFields: (pageIndex?: number) => Array<Record<string, unknown>>;
        serializeField: (field: Record<string, unknown>) => Record<string, unknown>;
        classifyField: (field: Record<string, unknown>) => string;
        blockers: () => Array<Record<string, unknown>>;
        nextAction: () => Element | null;
        finalAction: () => Element | null;
      };
    }).InternshipPilotAutofillEngine;
    if (!engine) throw new Error("Autofill engine did not load.");
    const fields = engine.scanFields(1);
    const serialized = fields.map((field) => engine.serializeField(field));
    const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim() || null;
    const actionLabels = [...document.querySelectorAll("button, a, [role='button']")]
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .map((element) => text(element) || element.getAttribute("aria-label") || "")
      .filter(Boolean)
      .slice(0, 40);
    return {
      url: location.href,
      title: document.title,
      fieldCount: fields.length,
      requiredCount: fields.filter((field) => field.required).length,
      categories: [...new Set(fields.map((field) => engine.classifyField(field)))],
      fieldTypes: [...new Set(fields.map((field) => String(field.type)))],
      labels: serialized.map((field) => String(field.accessibleName || field.questionText || field.label || field.name || "")).filter(Boolean).slice(0, 80),
      fieldSummaries: serialized.slice(0, 100).map((field) => ({
        label: String(field.accessibleName || field.questionText || field.label || field.name || ""),
        type: String(field.type || ""),
        required: Boolean(field.required),
        category: engine.classifyField(field),
        name: String(field.name || ""),
        placeholder: String(field.placeholder || ""),
        section: String(field.section || ""),
      })),
      blockers: engine.blockers(),
      nextAction: text(engine.nextAction()),
      finalAction: text(engine.finalAction()),
      bodyExcerpt: document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 800) || "",
      actionLabels,
      enteredPersonalData: false as const,
      submitted: false as const,
      navigationError: errorMessage,
    };
  }, navigationError);
  return result as Reconnaissance;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript({ path: path.resolve("extension/dist/autofill-engine.js") });
  try {
    for (const target of targets) {
      const page = await context.newPage();
      try {
        await page.addInitScript(() => {
          (globalThis as typeof globalThis & { __name?: (value: unknown) => unknown }).__name = (value) => value;
        });
        const result = await inspect(page, target);
        console.log(JSON.stringify({ target: target.name, ...result }, null, 2));
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
