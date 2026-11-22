import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  headlessChromiumLaunchArgs,
  resolveChromiumExecutablePath,
} from "./chromiumExecutable";

describe("chromiumExecutable", () => {
  it("resolves a usable Chromium or chrome-headless-shell executable when installed", async () => {
    const exePath = await resolveChromiumExecutablePath();
    if (exePath !== null) {
      expect(existsSync(exePath)).toBe(true);
    } else {
      expect(exePath).toBeNull();
    }
  });

  it("includes container-safe Chromium flags", () => {
    const args = headlessChromiumLaunchArgs();
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-setuid-sandbox");
    expect(args).toContain("--disable-dev-shm-usage");
  });
});
