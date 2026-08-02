import path from "node:path";
import { spawn } from "node:child_process";

function absolute(relativePath: string): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), relativePath);
}

// Best-effort desktop notification for a newly detected assessment
// (Milestone 7). Never blocks or throws — a notification failing shouldn't
// break the Gmail sync pipeline.
export function notifyWindows(title: string, message: string): void {
  try {
    const scriptPath = absolute("scripts/notify-windows.ps1");
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Title", title, "-Message", message],
      { windowsHide: true, stdio: "ignore" },
    );
    proc.on("error", () => {});
  } catch {
    // Non-fatal.
  }
}
