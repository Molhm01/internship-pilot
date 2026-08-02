import "dotenv/config";
import { getAgentDiagnostics } from "@/lib/applications/diagnostics";

async function testDiagnosticsEndpoint() {
  console.log("=== Testing Agent Diagnostics Function ===");
  try {
    const diag = await getAgentDiagnostics();
    console.log("PASS: getAgentDiagnostics() executed cleanly and returned JSON.");
    console.log("Diagnostics result summary:", {
      browserCanLaunch: diag.checks.browserCanLaunch,
      browserProfileOwnedByOneWorker: diag.checks.browserProfileOwnedByOneWorker,
      extensionLoadedByWorker: diag.checks.extensionLoadedByWorker,
      lastAgentError: diag.lastAgentError,
    });
  } catch (err) {
    console.error("FAIL: getAgentDiagnostics() threw an error:", err);
    process.exit(1);
  }
}

void testDiagnosticsEndpoint();
