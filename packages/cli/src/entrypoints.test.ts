import { isFunction, overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as index from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("index barrel", () => {
  it("re-exports the public surface", () => {
    expect(isFunction(index.parseArgs)).toBe(true);
    expect(isFunction(index.helpText)).toBe(true);
    expect(isFunction(index.runCli)).toBe(true);
    expect(index.SessionFileSchema).toBeDefined();
    expect(index.GlobalFlagsSchema).toBeDefined();
  });
});

describe("bin entrypoint", () => {
  it("runs the CLI from process.argv and exits with its code", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(overlapCast(() => undefined));
    const argv = process.argv;
    process.argv = ["node", "opensesame-id", "--help"];
    try {
      await import("./bin.js");
    } finally {
      process.argv = argv;
    }
    expect(exit).toHaveBeenCalledWith(0);
  });
});
