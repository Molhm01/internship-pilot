import { spawn } from "node:child_process";

export function typstBin(): string {
  return /* turbopackIgnore: true */ process.env.TYPST_BIN || "typst";
}

// Content is always inserted into Typst string literals ("...") rather than
// raw markup, so we only need to escape what a string literal needs.
export function escapeTypstString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function typstStringArray(items: string[]): string {
  return `(${items.map((i) => `"${escapeTypstString(i)}"`).join(", ")}${items.length === 1 ? "," : ""})`;
}

export async function compileTypst(
  sourcePath: string,
  outputPdfPath: string,
  projectRoot: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    let settled = false;
    try {
      // Typst sandboxes file access to a "project root" (defaults to the
      // source file's own directory, which would block our template import
      // living several directories up). --root widens that sandbox to the
      // whole app project, and generated sources import the template via a
      // root-relative "/templates/..." path rather than "../../..".
      proc = spawn(/* turbopackIgnore: true */ typstBin(), ["compile", "--root", projectRoot, "--font-path", "templates/fonts", sourcePath, outputPdfPath], {
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill();
      } catch {
        // The bounded response is more important than surfacing kill details.
      }
      resolve({ ok: false, stderr: `Typst compilation timed out after ${timeoutMs}ms.` });
    }, timeoutMs);
    const finish = (result: { ok: boolean; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => finish({ ok: code === 0, stderr }));
    proc.on("error", (err) => finish({ ok: false, stderr: err.message }));
  });
}
