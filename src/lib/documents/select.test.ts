import { describe, expect, it, vi } from "vitest";

const ollamaGenerateJSON = vi.fn();

vi.mock("@/lib/ollama", () => ({
  ollamaGenerateJSON: (...args: unknown[]) => ollamaGenerateJSON(...args),
}));

import { DOCUMENT_SELECTION_MODEL_TIMEOUT_MS, selectContentForJob } from "./select";

describe("tailored-document model selection", () => {
  it("uses a bounded model request and keeps only existing bullet IDs", async () => {
    ollamaGenerateJSON.mockResolvedValue({
      experienceBulletIds: ["approved", "invented"],
      projectBulletIds: [],
      activityBulletIds: [],
      coverLetterParagraphs: ["Grounded paragraph one.", "Grounded paragraph two."],
    });

    const result = await selectContentForJob(
      { title: "Intern", company: "Acme", description: "Diagnose hardware." },
      [{ id: "approved", category: "experience", text: "Diagnosed hardware failures." }],
      [{ id: "fact-1", type: "experience", content: "Diagnosed hardware failures.", detail: null }],
    );

    expect(DOCUMENT_SELECTION_MODEL_TIMEOUT_MS).toBe(30_000);
    expect(ollamaGenerateJSON).toHaveBeenCalledWith(expect.any(String), { timeoutMs: 30_000 });
    expect(result.experienceBulletIds).toEqual(["approved"]);
  });
});
