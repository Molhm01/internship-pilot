import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);

if (!existsSync(new URL("src/generated/prisma/client.ts", root))) {
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [require.resolve("prisma/build/index.js"), "generate"], {
    cwd: root,
    env: { ...process.env, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
