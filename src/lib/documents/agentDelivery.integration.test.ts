import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliverDocumentToAgent, resolveAgentToken, tailoredFilename } from "./agentDelivery";

/**
 * The website-to-agent hop, end to end, over a real socket.
 *
 * `fetch` is deliberately not stubbed here. The failure this test exists to
 * catch was invisible to every unit test in the repository: the request was
 * built correctly and sent correctly, and the agent answered 401 because the two
 * processes had been configured with different tokens. Nothing short of a real
 * request to a real listener that really checks the header would have failed.
 *
 * The listener below is the agent's documented contract, implemented the way the
 * agent implements it — bearer check first, checksum verified before anything is
 * written, bytes on disk, one "latest" pointer per document type.
 */

const TOKEN = randomBytes(32).toString("hex");

type StoredDocument = {
  id: string;
  documentType: "resume" | "cover_letter";
  filename: string;
  mimeType: string;
  byteLength: number;
  createdAt: string;
  source: string;
  company?: string;
  jobTitle?: string;
  jobId?: string;
  checksum: string;
  diskPath: string;
};

let server: Server;
let baseUrl: string;
let storageDir: string;
let latest: Partial<Record<"resume" | "cover_letter", StoredDocument>>;
let unauthorizedRequests: number;

function readJsonBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function send(response: import("node:http").ServerResponse, status: number, payload: unknown) {
  const encoded = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(encoded);
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), "agent-documents-"));

  server = createServer((request, response) => {
    void (async () => {
      // Exactly what the agent does: no route runs before the token matches.
      if (request.headers["x-agent-token"] !== TOKEN) {
        unauthorizedRequests += 1;
        return send(response, 401, {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Missing or invalid x-agent-token header." },
        });
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/documents/latest") {
        return send(response, 200, {
          ok: true,
          data: {
            resume: latest.resume ? record(latest.resume) : null,
            coverLetter: latest.cover_letter ? record(latest.cover_letter) : null,
          },
        });
      }

      const contentMatch = url.pathname.match(/^\/documents\/latest\/([^/]+)\/content$/);
      if (request.method === "GET" && contentMatch) {
        const found = Object.values(latest).find((entry) => entry?.id === contentMatch[1]);
        if (!found) {
          return send(response, 404, { ok: false, error: { code: "DOCUMENT_MISSING" } });
        }
        const bytes = await readFile(found.diskPath);
        return send(response, 200, {
          ok: true,
          data: { ...record(found), contentBase64: bytes.toString("base64") },
        });
      }

      if (request.method === "POST" && url.pathname === "/documents/latest") {
        const parsed = JSON.parse(await readJsonBody(request)) as Record<string, string>;
        const bytes = Buffer.from(parsed.contentBase64.replace(/\s/g, ""), "base64");
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (checksum !== parsed.checksum) {
          return send(response, 422, {
            ok: false,
            error: { code: "VALIDATION_FAILED", message: "checksum mismatch" },
          });
        }

        const id = `doc-${randomBytes(8).toString("hex")}`;
        const diskPath = path.join(storageDir, `${id}.pdf`);
        await writeFile(diskPath, bytes);
        const documentType = parsed.documentType as "resume" | "cover_letter";
        const stored: StoredDocument = {
          id,
          documentType,
          filename: parsed.filename,
          mimeType: parsed.mimeType,
          byteLength: bytes.byteLength,
          createdAt: parsed.createdAt ?? new Date().toISOString(),
          source: parsed.source,
          ...(parsed.company ? { company: parsed.company } : {}),
          ...(parsed.jobTitle ? { jobTitle: parsed.jobTitle } : {}),
          ...(parsed.jobId ? { jobId: parsed.jobId } : {}),
          checksum,
          diskPath,
        };
        latest[documentType] = stored;
        return send(response, 201, { ok: true, data: record(stored) });
      }

      return send(response, 404, { ok: false, error: { code: "NOT_FOUND" } });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("The test agent did not bind a port.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

/** The wire record, without the server-private disk path. */
function record(stored: StoredDocument): Omit<StoredDocument, "diskPath"> {
  const wire: Partial<StoredDocument> = { ...stored };
  delete wire.diskPath;
  return wire as Omit<StoredDocument, "diskPath">;
}

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(storageDir, { recursive: true, force: true });
});

beforeEach(() => {
  latest = {};
  unauthorizedRequests = 0;
  process.env.INTERNSHIP_AGENT_BASE_URL = baseUrl;
  process.env.INTERNSHIP_AGENT_TOKEN = TOKEN;
  delete process.env.INTERNSHIP_AGENT_TOKEN_FILE;
});

afterEach(() => {
  delete process.env.INTERNSHIP_AGENT_BASE_URL;
  delete process.env.INTERNSHIP_AGENT_TOKEN;
  delete process.env.INTERNSHIP_AGENT_TOKEN_FILE;
});

/**
 * A real tailored PDF when this checkout has one, and a valid minimal PDF
 * otherwise, so the test proves the transport on a developer machine that has
 * never run generation.
 */
async function testPdf(kind: "resume" | "cover-letter"): Promise<Uint8Array> {
  const generatedRoot = path.join(process.cwd(), "data", "generated");
  if (existsSync(generatedRoot)) {
    const { readdir } = await import("node:fs/promises");
    for (const jobDir of await readdir(generatedRoot)) {
      const candidate = path.join(generatedRoot, jobDir, `${kind}-v1.pdf`);
      if (existsSync(candidate)) {
        const bytes = new Uint8Array(await readFile(candidate));
        if (bytes.byteLength > 0) return bytes;
      }
    }
  }
  return new Uint8Array(
    Buffer.from(`%PDF-1.4\n% ${kind} fixture\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n`),
  );
}

async function fetchLatest() {
  const response = await fetch(`${baseUrl}/documents/latest`, {
    headers: { "x-agent-token": TOKEN },
  });
  const payload = await response.json() as { data: { resume: StoredDocument | null; coverLetter: StoredDocument | null } };
  return payload.data;
}

describe("delivering both documents to a live agent over loopback HTTP", () => {
  it("stores both files, keeps the bytes intact, and points latest at each", async () => {
    const resumeBytes = await testPdf("resume");
    const coverBytes = await testPdf("cover-letter");
    expect(resumeBytes.byteLength).toBeGreaterThan(0);
    expect(coverBytes.byteLength).toBeGreaterThan(0);

    const resumeOutcome = await deliverDocumentToAgent({
      documentType: "resume",
      filename: tailoredFilename("resume", "Acme", "Software Engineering Intern"),
      bytes: resumeBytes,
      source: "tailored",
      company: "Acme",
      jobTitle: "Software Engineering Intern",
      jobId: "job-1",
    });
    const coverOutcome = await deliverDocumentToAgent({
      documentType: "cover_letter",
      filename: tailoredFilename("cover_letter", "Acme", "Software Engineering Intern"),
      bytes: coverBytes,
      source: "tailored",
      company: "Acme",
      jobTitle: "Software Engineering Intern",
      jobId: "job-1",
    });

    expect(resumeOutcome.delivered).toBe(true);
    expect(coverOutcome.delivered).toBe(true);
    if (!resumeOutcome.delivered || !coverOutcome.delivered) return;

    // Persisted, and persisted as the bytes that were sent rather than a
    // truncated or re-encoded copy.
    const storedResume = await readFile(latest.resume!.diskPath);
    const storedCover = await readFile(latest.cover_letter!.diskPath);
    expect(storedResume.byteLength).toBe(resumeBytes.byteLength);
    expect(storedCover.byteLength).toBe(coverBytes.byteLength);
    expect(createHash("sha256").update(storedResume).digest("hex"))
      .toBe(createHash("sha256").update(resumeBytes).digest("hex"));
    expect(createHash("sha256").update(storedCover).digest("hex"))
      .toBe(createHash("sha256").update(coverBytes).digest("hex"));

    // The latest pointers resolve to the right document, not to each other.
    const list = await fetchLatest();
    expect(list.resume?.id).toBe(resumeOutcome.documentId);
    expect(list.resume?.documentType).toBe("resume");
    expect(list.resume?.byteLength).toBe(resumeBytes.byteLength);
    expect(list.coverLetter?.id).toBe(coverOutcome.documentId);
    expect(list.coverLetter?.documentType).toBe("cover_letter");
    expect(list.coverLetter?.byteLength).toBe(coverBytes.byteLength);
    expect(list.resume?.id).not.toBe(list.coverLetter?.id);
  });

  it("returns each stored document over the contract the extension reads", async () => {
    const resumeBytes = await testPdf("resume");
    const outcome = await deliverDocumentToAgent({
      documentType: "resume",
      filename: "Resume-Acme-Intern.pdf",
      bytes: resumeBytes,
      source: "tailored",
      company: "Acme",
      jobTitle: "Software Engineering Intern",
      jobId: "job-1",
    });
    expect(outcome.delivered).toBe(true);
    if (!outcome.delivered) return;

    const response = await fetch(`${baseUrl}/documents/latest/${outcome.documentId}/content`, {
      headers: { "x-agent-token": TOKEN },
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; data: Record<string, unknown> };

    // Every field the extension needs to render the popup and build a File.
    expect(payload.ok).toBe(true);
    expect(payload.data.documentType).toBe("resume");
    expect(payload.data.mimeType).toBe("application/pdf");
    expect(payload.data.source).toBe("tailored");
    expect(payload.data.company).toBe("Acme");
    expect(payload.data.jobTitle).toBe("Software Engineering Intern");
    expect(payload.data.jobId).toBe("job-1");
    expect(payload.data.byteLength).toBe(resumeBytes.byteLength);
    expect(payload.data.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.data.checksum)
      .toBe(createHash("sha256").update(resumeBytes).digest("hex"));

    const returned = Buffer.from(payload.data.contentBase64 as string, "base64");
    expect(new Uint8Array(returned)).toEqual(resumeBytes);
  });

  it("reports a token mismatch as an authentication problem and stores nothing", async () => {
    process.env.INTERNSHIP_AGENT_TOKEN = randomBytes(32).toString("hex");

    const outcome = await deliverDocumentToAgent({
      documentType: "resume",
      filename: "Resume-Acme-Intern.pdf",
      bytes: await testPdf("resume"),
      source: "tailored",
    });

    // The exact failure that made every real delivery vanish: the request was
    // sent, the agent answered, and the answer was 401.
    expect(unauthorizedRequests).toBe(1);
    expect(outcome.delivered).toBe(false);
    if (outcome.delivered) return;
    expect(outcome.reason).toContain("rejected");
    expect(outcome.reason).toContain("INTERNSHIP_AGENT_TOKEN_FILE");
    expect(outcome.reason).not.toContain(process.env.INTERNSHIP_AGENT_TOKEN);
    expect(latest.resume).toBeUndefined();
  });

  it("authenticates with the agent's token file in preference to a stale env copy", async () => {
    const tokenFile = path.join(storageDir, "agent-token.txt");
    writeFileSync(tokenFile, `${TOKEN}\n`);
    process.env.INTERNSHIP_AGENT_TOKEN_FILE = tokenFile;
    process.env.INTERNSHIP_AGENT_TOKEN = randomBytes(32).toString("hex");

    expect(resolveAgentToken()).toEqual({ token: TOKEN });

    const outcome = await deliverDocumentToAgent({
      documentType: "cover_letter",
      filename: "Cover-Letter-Acme-Intern.pdf",
      bytes: await testPdf("cover-letter"),
      source: "tailored",
    });

    expect(unauthorizedRequests).toBe(0);
    expect(outcome.delivered).toBe(true);
    expect(latest.cover_letter).toBeDefined();
  });
});
