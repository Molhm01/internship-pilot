import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const deleteCompany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    company: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      delete: (...args: unknown[]) => deleteCompany(...args),
      // DELETE's sibling handlers share this module; keep the surface they use.
      update: vi.fn(),
    },
  },
}));

import { DELETE } from "./route";

function del(id: string) {
  return DELETE(new Request(`http://localhost/api/companies/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

describe("DELETE /api/companies/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireCatalogueAdmin.mockResolvedValue(null); // owner allowed
  });

  it("passes the gate's denial straight through", async () => {
    requireCatalogueAdmin.mockResolvedValue(
      new (await import("next/server")).NextResponse(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    );

    const response = await del("company-0");

    expect(response.status).toBe(403);
    expect(findUnique).not.toHaveBeenCalled();
    expect(deleteCompany).not.toHaveBeenCalled();
  });

  it("refuses to delete a CSV-seeded catalogue entry", async () => {
    findUnique.mockResolvedValue({ source: "csv" });

    const response = await del("company-1");

    expect(response.status).toBe(409);
    expect(deleteCompany).not.toHaveBeenCalled();
  });

  it("refuses to delete an Intern-List-sourced entry", async () => {
    findUnique.mockResolvedValue({ source: "intern_list" });

    const response = await del("company-2");

    expect(response.status).toBe(409);
    expect(deleteCompany).not.toHaveBeenCalled();
  });

  it("deletes a manually-added entry", async () => {
    findUnique.mockResolvedValue({ source: "manual" });
    deleteCompany.mockResolvedValue({});

    const response = await del("company-3");

    expect(response.status).toBe(200);
    expect(deleteCompany).toHaveBeenCalledWith({ where: { id: "company-3" } });
  });

  it("404s on an unknown company", async () => {
    findUnique.mockResolvedValue(null);

    const response = await del("nope");

    expect(response.status).toBe(404);
    expect(deleteCompany).not.toHaveBeenCalled();
  });
});

// Auth modules fully mocked: no real auth import, no env secrets needed.
// The gate's own logic (allowlist parsing, fail-closed) is covered by
// src/lib/auth/catalogueAdmin.test.ts; these tests cover the route's use of it.
const requireCatalogueAdmin = vi.fn();

vi.mock("@/lib/auth/catalogueAdmin", () => ({
  requireCatalogueAdmin: (...args: unknown[]) => requireCatalogueAdmin(...args),
}));
