import { beforeEach, describe, expect, it, vi } from "vitest";

const factFindMany = vi.fn();
const bulletDeleteMany = vi.fn();
const bulletCreate = vi.fn();
const ollamaGenerateJSON = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    resumeFact: { findMany: (...args: unknown[]) => factFindMany(...args) },
    resumeBullet: {
      deleteMany: (...args: unknown[]) => bulletDeleteMany(...args),
      create: (...args: unknown[]) => bulletCreate(...args),
    },
  },
}));

vi.mock("@/lib/ollama", () => ({
  ollamaGenerateJSON: (...args: unknown[]) => ollamaGenerateJSON(...args),
}));

import { generateBulletLibrary } from "./bulletLibrary";

const OWNER = "user-a";

describe("résumé bullet library ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    factFindMany.mockResolvedValue([
      { id: "fact-1", type: "experience", content: "Built test rigs", detail: "For a lab", status: "approved" },
    ]);
    ollamaGenerateJSON.mockResolvedValue({
      bullets: [{ category: "experience", text: "Built test rigs for a lab", factIds: ["fact-1"] }],
    });
    bulletDeleteMany.mockResolvedValue({ count: 0 });
    bulletCreate.mockResolvedValue({ id: "bullet-1" });
  });

  it("regenerating one library never deletes another account's bullets", async () => {
    await generateBulletLibrary(OWNER);

    // The bug this guards: `deleteMany({})` wiped every account's bullets
    // whenever one person regenerated their own library.
    expect(bulletDeleteMany).toHaveBeenCalledWith({ where: { userId: OWNER } });
    const [deleteArgs] = bulletDeleteMany.mock.calls[0] as [{ where?: { userId?: string } }];
    expect(deleteArgs?.where?.userId).toBe(OWNER);
  });

  it("writes every bullet with an owner", async () => {
    await generateBulletLibrary(OWNER);

    // A bullet with no userId is readable by every account, because the
    // routes that read them filter on exactly that column.
    expect(bulletCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: OWNER }),
    });
  });

  it("reads only the asking user's approved facts", async () => {
    await generateBulletLibrary(OWNER);

    expect(factFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: OWNER }) }),
    );
  });

  it("refuses to store a bullet that cites no approved fact of this user's", async () => {
    ollamaGenerateJSON.mockResolvedValue({
      bullets: [
        { category: "experience", text: "Cites somebody else's evidence", factIds: ["fact-belonging-to-user-b"] },
        { category: "experience", text: "Built test rigs for a lab", factIds: ["fact-1"] },
      ],
    });

    const result = await generateBulletLibrary(OWNER);

    expect(result).toEqual({ count: 1, rejected: 1 });
    expect(bulletCreate).toHaveBeenCalledTimes(1);
  });
});
