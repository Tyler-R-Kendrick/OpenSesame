import { describe, expect, it } from "vitest";
import { type CommandPorts, executeCommand } from "./execute.js";
import { parseCommand } from "./parse.js";
import { commandPathAuthorized } from "./types.js";

function ports(navigated: string[]): CommandPorts {
  return {
    navigate: (path) => {
      navigated.push(path);
    },
    copy: async () => "unavailable",
    items: () => [],
    vaultLocked: () => false,
  };
}

describe("join navigation", () => {
  it("opens join with a vault already on the device and no capability lease", async () => {
    expect(commandPathAuthorized("/join")).toBe(true);
    const navigated: string[] = [];
    for (const utterance of [
      "go to join",
      "join",
      "join a session",
      "open join",
      "open a join",
      "show join",
      "/join",
    ]) {
      const command = parseCommand(utterance);
      expect(command, utterance).toEqual({
        action: "navigate",
        path: "/join",
      });
      const outcome = await executeCommand(
        command ?? { action: "help" },
        ports(navigated),
      );
      expect(outcome.ok, utterance).toBe(true);
    }
    expect(navigated).toEqual([
      "/join",
      "/join",
      "/join",
      "/join",
      "/join",
      "/join",
      "/join",
    ]);
    expect(parseCommand("open sessions")).toEqual({
      action: "navigate",
      path: "/access",
    });
    expect(parseCommand("open a session")).toEqual({
      action: "open_item",
      query: "a session",
    });
  });
});
