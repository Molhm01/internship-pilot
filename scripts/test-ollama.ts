import "dotenv/config";
import { checkOllamaHealth, ollamaGenerateJSON, OLLAMA_MODEL } from "@/lib/ollama";

async function main() {
  console.log(`Checking Ollama connection (model: ${OLLAMA_MODEL})...`);
  const health = await checkOllamaHealth();
  console.log(JSON.stringify(health, null, 2));

  if (!health.reachable) {
    throw new Error("Ollama is not reachable at http://localhost:11434. Run `ollama serve`.");
  }
  if (!health.modelInstalled) {
    throw new Error(
      `Model "${OLLAMA_MODEL}" is not installed. Run: ollama pull ${OLLAMA_MODEL}`,
    );
  }

  console.log("Running a tiny generate call to confirm the model responds with valid JSON...");
  const result = await ollamaGenerateJSON<{ ok: boolean }>(
    'Return ONLY this exact JSON object, nothing else: {"ok": true}',
    { timeoutMs: 60_000 },
  );
  console.log("Model responded:", result);
  if (result.ok !== true) {
    throw new Error("Model did not echo back the expected JSON.");
  }

  console.log("\nOllama connection test PASSED.");
}

main().catch((err) => {
  console.error("\nOllama connection test FAILED:", err.message);
  process.exitCode = 1;
});
