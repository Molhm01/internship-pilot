import "dotenv/config";

async function testRoutes() {
  console.log("=== Testing Server Routes on http://localhost:3000 ===");
  
  const routes = [
    "/",
    "/jobs",
    "/agent-diagnostics",
    "/api/agent-diagnostics",
  ];

  const results: Record<string, { status: number; ok: boolean }> = {};

  for (const route of routes) {
    const url = `http://localhost:3000${route}`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      results[route] = { status: res.status, ok: res.ok };
      console.log(`  Route ${route.padEnd(24)} -> HTTP ${res.status} (${res.ok ? "OK" : "FAIL"})`);
      if (route === "/api/agent-diagnostics" && res.ok) {
        const body = await res.json();
        console.log("  /api/agent-diagnostics response summary:", {
          browserCanLaunch: body.checks?.browserCanLaunch?.pass,
          browserProfileOwnedByOneWorker: body.checks?.browserProfileOwnedByOneWorker?.pass,
          extensionLoadedByWorker: body.checks?.extensionLoadedByWorker?.pass,
        });
      }
    } catch (err) {
      console.error(`  Route ${route.padEnd(24)} -> FETCH ERROR:`, err instanceof Error ? err.message : String(err));
      results[route] = { status: 0, ok: false };
    }
  }

  const allPassed = Object.values(results).every(r => r.status === 200 && r.ok);
  if (!allPassed) {
    console.error("\nFAIL: Not all required routes returned HTTP 200!");
    process.exit(1);
  }

  console.log("\nPASS: All 4 required routes returned HTTP 200 OK cleanly.");
}

void testRoutes();
