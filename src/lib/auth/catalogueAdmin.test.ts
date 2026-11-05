import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "u1", email: "owner@example.test", name: "Owner", image: null, emailVerified: true };
const currentUser = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  currentUser: (...args: unknown[]) => currentUser(...args),
}));

import { isCatalogueAdmin, requireCatalogueAdmin } from "./catalogueAdmin";

describe("catalogue admin gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.CATALOGUE_ADMIN_EMAILS;
  });

  it("allows a listed owner email, case-insensitively", async () => {
    process.env.CATALOGUE_ADMIN_EMAILS = "Owner@Example.Test, other@example.test";
    currentUser.mockResolvedValue(user);
    await expect(isCatalogueAdmin()).resolves.toBe(true);
    await expect(requireCatalogueAdmin()).resolves.toBeNull();
  });

  it("denies a signed-in user who is not listed", async () => {
    process.env.CATALOGUE_ADMIN_EMAILS = "someone@example.test";
    currentUser.mockResolvedValue(user);
    await expect(isCatalogueAdmin()).resolves.toBe(false);
    const res = await requireCatalogueAdmin();
    expect(res?.status).toBe(403);
  });

  it("fails closed when the allowlist is unset", async () => {
    currentUser.mockResolvedValue(user);
    await expect(isCatalogueAdmin()).resolves.toBe(false);
    const res = await requireCatalogueAdmin();
    expect(res?.status).toBe(403);
  });

  it("returns 401 when signed out", async () => {
    currentUser.mockResolvedValue(null);
    const res = await requireCatalogueAdmin();
    expect(res?.status).toBe(401);
  });
});
