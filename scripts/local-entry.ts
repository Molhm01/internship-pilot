import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const args = process.argv.slice(2);

const EMBEDDING_ONLY_HINT = /(embed|embedding|nomic|mxbai|all-minilm|snowflake-arctic|bge(?:-|:)|e5(?:-|:))/i;
// Local text extraction and ATS matching favor fast structured-output models.
// gpt-oss remains a capable fallback, but should not be the first choice for a
// one-page resume when a Qwen/Llama/Gemma-class chat model is already installed.
const CHAT_MODEL_PREFERENCE = [
  /^qwen3\.5(?::|$)/i,
  /^qwen3(?::|$)/i,
  /^qwen2\.5(?::|$)/i,
  /^llama3/i,
  /^gemma/i,
  /^mistral/i,
  /^phi/i,
  /^gpt-oss(?::|$)/i,
  /^deepseek/i,
] as const;

function installedOllamaModels(): string[] {
  const result = spawnSync("ollama", ["list"], {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error || result.status !== 0) return [];

  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^NAME\s+/i.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

function sameModelFamily(left: string, right: string): boolean {
  return left.split(":")[0].toLowerCase() === right.split(":")[0].toLowerCase();
}

function chooseChatModel(models: string[]): string | null {
  if (models.length === 0) return null;

  const requested = process.env.OLLAMA_MODEL?.trim();
  if (requested) {
    const exact = models.find((model) => model.toLowerCase() === requested.toLowerCase());
    if (exact) return exact;

    const familyMatch = models.find((model) => sameModelFamily(model, requested));
    if (familyMatch) {
      console.warn(`[local] Requested Ollama model ${requested} is not installed; using installed tag ${familyMatch} instead.`);
      return familyMatch;
    }

    console.warn(`[local] Requested Ollama model ${requested} is not installed; selecting another installed chat model.`);
  }

  const chatModels = models.filter((model) => !EMBEDDING_ONLY_HINT.test(model));
  if (chatModels.length === 0) return null;

  for (const pattern of CHAT_MODEL_PREFERENCE) {
    const preferred = chatModels.find((model) => pattern.test(model));
    if (preferred) return preferred;
  }

  return chatModels[0];
}

function configureOllamaModel(): void {
  if (args.includes("--production")) return;

  const models = installedOllamaModels();
  if (models.length === 0) {
    console.warn("[local] ⚠ Ollama is not reachable or has no installed models. The website can still run, but local AI features will be unavailable.");
    return;
  }

  const selected = chooseChatModel(models);
  if (!selected) {
    console.warn(`[local] ⚠ Ollama is running, but no usable chat model was found. Installed models: ${models.join(", ")}`);
    return;
  }

  // Environment variables inherited by the child take precedence over values
  // loaded later from .env files by Next.js. This guarantees every local AI
  // caller (resume analysis, ATS scoring, and the application worker) uses the
  // exact model tag that actually exists on this machine.
  process.env.OLLAMA_MODEL = selected;
  console.log(`[local] ✓ Ollama model selected: ${selected}`);
}

function forwardSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
    } catch {
      // The child may already be exiting from the same terminal signal.
    }
  }
}

configureOllamaModel();

const child = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/local.ts", ...args],
  {
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  },
);

process.once("SIGINT", () => forwardSignal(child, "SIGINT"));
process.once("SIGTERM", () => forwardSignal(child, "SIGTERM"));

child.once("error", (error) => {
  console.error(`[local] Could not start the local supervisor: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
