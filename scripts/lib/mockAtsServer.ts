import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The mock employer, served as its own site.
 *
 * These fixture pages used to be fetched from the application's own origin,
 * which quietly made them part of the signed-in workspace: the route proxy
 * protects everything that is not explicitly public, so an unauthenticated
 * capture of "the employer's job page" got a 307 to /login and read the login
 * form as the job description.
 *
 * Standing them up on their own port is both the fix and the more honest
 * fixture. An employer's application page is not part of Internship Pilot, has
 * no session with it, and must be reachable without one — which is exactly what
 * a separate origin models. It also means the proxy keeps its deliberately
 * broad matcher instead of growing a test-only carve-out that would ship to
 * production.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export type MockAtsServer = {
  /** e.g. http://127.0.0.1:31541 — fixture pages hang directly off the root. */
  baseUrl: string;
  close: () => Promise<void>;
};

export async function startMockAtsServer(port: number): Promise<MockAtsServer> {
  const root = path.join(process.cwd(), "public", "mock-ats");

  const server: Server = createServer((request, response) => {
    void (async () => {
      const requested = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const name = path.basename(requested);
      // Only files directly inside the fixture directory. Rebuilding the path
      // from the basename means a "../" cannot walk out of it.
      const filePath = path.join(root, name);
      if (!filePath.startsWith(root) || name === "" || name === ".") {
        response.writeHead(404).end("Not found");
        return;
      }
      try {
        const body = await readFile(filePath);
        response.writeHead(200, {
          "content-type": CONTENT_TYPES[path.extname(name)] ?? "application/octet-stream",
          "cache-control": "no-store",
        }).end(body);
      } catch {
        response.writeHead(404).end("Not found");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
