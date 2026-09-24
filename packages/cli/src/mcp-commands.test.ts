import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_USAGE, runMcp } from "./mcp-commands.js";
import { helpText } from "./parse.js";

describe("opensesame-id mcp", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves the named server and keeps the process alive", async () => {
    const main = vi.fn(async () => {});
    const load = vi.fn(async () => ({ main }));
    await expect(runMcp(["host"], load)).resolves.toBeUndefined();
    await expect(runMcp(["client"], load)).resolves.toBeUndefined();
    expect(load.mock.calls).toEqual([["host"], ["client"]]);
    expect(main).toHaveBeenCalledTimes(2);
  });

  it("refuses anything else with usage", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const load = vi.fn();
    for (const args of [[], ["daemon"], ["host", "extra"]]) {
      await expect(runMcp(args, load)).resolves.toBe(2);
    }
    expect(load).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(`${MCP_USAGE}\n`);
  });

  it("is listed in the help", () => {
    expect(helpText()).toContain("mcp host|client");
  });

  it("loads the real packages", async () => {
    const host = await import("@opensesame/mcp-host");
    const client = await import("@opensesame/mcp-client");
    expect(typeof host.main).toBe("function");
    expect(typeof client.main).toBe("function");
  });
});
