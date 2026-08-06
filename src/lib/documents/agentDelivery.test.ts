import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentBaseUrl, checksumOf, deliverDocumentToAgent, tailoredFilename } from "./agentDelivery";

/**
 * Delivering a generated PDF to the local Internship Agent. The extension
 * attaches whatever the agent holds, so a delivery that silently half-succeeded
 * would be indistinguishable, later, from a résumé that was never generated.
 */

const BYTES = new Uint8Array(Buffer.from("%PDF-1.4\ntailored\n%%EOF\n"));

function okResponse(id = "doc-1"): Response {
  return new Response(JSON.stringify({ ok: true, data: { id } }), { status: 201 });
}

beforeEach(() => {
  process.env.INTERNSHIP_AGENT_TOKEN = "test-token-0123456789abcdef0123456789";
  process.env.INTERNSHIP_AGENT_BASE_URL = "http://127.0.0.1:4317";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.INTERNSHIP_AGENT_TOKEN;
  delete process.env.INTERNSHIP_AGENT_BASE_URL;
});

describe("delivering a document to the agent", () => {
  it("sends the bytes, the metadata, and a matching checksum", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(okResponse());

    const outcome = await deliverDocumentToAgent(
      {
        documentType: "resume",
        filename: "Resume-Acme-Intern.pdf",
        bytes: BYTES,
        source: "tailored",
        company: "Acme",
        jobTitle: "Software Engineering Intern",
        jobId: "job-1",
      },
      fetcher,
    );

    expect(outcome).toEqual({
      delivered: true,
      documentId: "doc-1",
      documentType: "resume",
      filename: "Resume-Acme-Intern.pdf",
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4317/documents/latest");
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body.documentType).toBe("resume");
    expect(body.filename).toBe("Resume-Acme-Intern.pdf");
    expect(body.mimeType).toBe("application/pdf");
    expect(body.checksum).toBe(createHash("sha256").update(BYTES).digest("hex"));
    expect(Buffer.from(String(body.contentBase64), "base64").equals(Buffer.from(BYTES))).toBe(true);
  });

  it("sends the token only in the header, never in the URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    await deliverDocumentToAgent(
      { documentType: "resume", filename: "r.pdf", bytes: BYTES, source: "tailored" },
      fetcher,
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).not.toContain(process.env.INTERNSHIP_AGENT_TOKEN);
    expect((init as RequestInit).headers).toMatchObject({
      "x-agent-token": process.env.INTERNSHIP_AGENT_TOKEN!,
    });
  });

  it("reports a failure rather than claiming a delivery when the agent is down", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
    const outcome = await deliverDocumentToAgent(
      { documentType: "resume", filename: "r.pdf", bytes: BYTES, source: "tailored" },
      fetcher,
    );
    expect(outcome.delivered).toBe(false);
    if (!outcome.delivered) expect(outcome.reason).toContain("did not answer");
  });

  it("reports the agent's own reason when it refuses the document", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { message: "checksum mismatch" } }), {
        status: 422,
      }),
    );
    const outcome = await deliverDocumentToAgent(
      { documentType: "cover_letter", filename: "c.pdf", bytes: BYTES, source: "tailored" },
      fetcher,
    );
    expect(outcome).toMatchObject({ delivered: false, reason: "checksum mismatch" });
  });

  it("refuses an empty file without contacting the agent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const outcome = await deliverDocumentToAgent(
      { documentType: "resume", filename: "r.pdf", bytes: new Uint8Array(), source: "tailored" },
      fetcher,
    );
    expect(outcome.delivered).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses to send anywhere but loopback", () => {
    process.env.INTERNSHIP_AGENT_BASE_URL = "http://192.168.1.20:4317";
    expect(() => agentBaseUrl()).toThrow(/loopback/);
    process.env.INTERNSHIP_AGENT_BASE_URL = "https://example.com";
    expect(() => agentBaseUrl()).toThrow(/loopback/);
  });

  it("normalizes localhost to the IPv4 address the agent binds", () => {
    process.env.INTERNSHIP_AGENT_BASE_URL = "http://localhost:4317";
    expect(agentBaseUrl()).toBe("http://127.0.0.1:4317");
  });

  it("builds a stable, ASCII filename from the job", () => {
    expect(tailoredFilename("resume", "Acme Corp.", "Software Engineering Intern")).toBe(
      "Resume-Acme-Corp-Software-Engineering-Intern.pdf",
    );
    expect(tailoredFilename("cover_letter", "Acme", "Intern")).toBe("Cover-Letter-Acme-Intern.pdf");
  });

  it("computes the same digest the agent verifies against", () => {
    expect(checksumOf(BYTES)).toBe(createHash("sha256").update(BYTES).digest("hex"));
  });
});
