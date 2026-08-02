import { NextResponse } from "next/server";
import { ollamaGenerateJSON, OllamaError } from "@/lib/ollama";
import { buildResumeAnalysisPrompt } from "@/lib/prompts";
import { resumeAnalysisResponseSchema } from "@/lib/validation";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const resumeText = typeof body?.resumeText === "string" ? body.resumeText.trim() : "";

  if (!resumeText) {
    return NextResponse.json({ error: "resumeText is required" }, { status: 400 });
  }
  if (resumeText.length < 30) {
    return NextResponse.json(
      { error: "Resume text looks too short to analyze. Paste your full resume." },
      { status: 400 },
    );
  }

  const prompt = buildResumeAnalysisPrompt(resumeText);

  try {
    const raw = await ollamaGenerateJSON(prompt, { timeoutMs: 180_000 });
    // Local models occasionally append a malformed partial fact (for
    // example, a type with no content) after otherwise valid output. Drop
    // only structurally incomplete items; the strict schema still validates
    // every surviving fact and no missing value is guessed or synthesized.
    const sanitized = raw && typeof raw === "object" && Array.isArray((raw as { facts?: unknown }).facts)
      ? {
          facts: (raw as { facts: unknown[] }).facts.filter(
            (fact): fact is Record<string, unknown> =>
              !!fact && typeof fact === "object" &&
              typeof (fact as Record<string, unknown>).type === "string" &&
              typeof (fact as Record<string, unknown>).content === "string" &&
              ((fact as Record<string, unknown>).content as string).trim().length > 0,
          ),
        }
      : raw;
    const parsed = resumeAnalysisResponseSchema.safeParse(sanitized);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "The AI model returned facts in an unexpected format. Try again, or shorten the resume text.",
          details: parsed.error.flatten(),
        },
        { status: 502 },
      );
    }

    // De-duplicate identical (type, content) pairs the model may repeat.
    const seen = new Set<string>();
    const facts = parsed.data.facts.filter((f) => {
      const key = `${f.type}::${f.content.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return NextResponse.json({ facts });
  } catch (err) {
    if (err instanceof OllamaError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error analyzing resume." },
      { status: 500 },
    );
  }
}
