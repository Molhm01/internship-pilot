import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn }));

import { compileTypst } from "./typst";

describe("Typst compilation boundary", () => {
  afterEach(() => vi.useRealTimers());

  it("kills a compiler that never closes and returns a timeout failure", async () => {
    vi.useFakeTimers();
    const process = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    process.stderr = new EventEmitter();
    process.kill = vi.fn();
    spawn.mockReturnValue(process);

    const compilation = compileTypst("resume.typ", "resume.pdf", ".", 25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(compilation).resolves.toEqual({
      ok: false,
      stderr: "Typst compilation timed out after 25ms.",
    });
    expect(process.kill).toHaveBeenCalledOnce();
  });
});
