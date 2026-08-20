import { afterEach, describe, expect, it, vi } from "vitest";
import { overlapCast, type BoundaryValue } from "@opensesame/os-domain";

const ORIGINAL_ARGV1 = process.argv[1];
const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_MOCK = process.env.MOCK_DEVICE_FLOW;

/** `delete process.env.X` trips lint/performance/noDelete; this is the same unset. */
function unsetEnv(key: string): void {
  Reflect.deleteProperty(process.env, key);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    unsetEnv(key);
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  if (ORIGINAL_ARGV1 !== undefined) {
    process.argv[1] = ORIGINAL_ARGV1;
  }
  restoreEnv("VITEST", ORIGINAL_VITEST);
  restoreEnv("MOCK_DEVICE_FLOW", ORIGINAL_MOCK);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe("main.ts CLI entry", () => {
  it("runs the device login to completion when executed as main.ts", async () => {
    vi.useFakeTimers();
    process.env.VITEST = "false";
    process.env.MOCK_DEVICE_FLOW = "1";
    process.argv[1] = "/opt/tools/main.ts";
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(overlapCast((chunk: BoundaryValue) => {
      writes.push(String(chunk));
      return true;
    }));

    await import("./main.js");
    // The default sleep waits one clamped poll interval (5s floor).
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);

    const output = writes.join("");
    expect(output).toContain("HEAD-LESS");
    expect(output).toContain("Device login complete");
    expect(output).not.toContain("DO_NOT_PRINT");
  });

  it("runs when invoked through a path naming the package", async () => {
    process.env.VITEST = "false";
    unsetEnv("MOCK_DEVICE_FLOW");
    // endsWith("main.ts") is false here; includes("example-headless") decides.
    process.argv[1] = "/opt/example-headless/bin";
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => overlapCast(undefined));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    await import("./main.js");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(errSpy).toHaveBeenCalledWith("connection refused\n");
  });

  it("stringifies non-Error failures on startup", async () => {
    process.env.VITEST = "false";
    unsetEnv("MOCK_DEVICE_FLOW");
    process.argv[1] = "/opt/tools/main.ts";
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => overlapCast(undefined));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("boom"));

    await import("./main.js");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(errSpy).toHaveBeenCalledWith("boom\n");
  });

  it("does not auto-run under a generic argv", async () => {
    process.env.VITEST = "false";
    unsetEnv("MOCK_DEVICE_FLOW");
    process.argv[1] = "/usr/bin/node";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await import("./main.js");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
