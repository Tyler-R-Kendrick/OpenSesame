import { describe, expect, it } from "vitest";
import { type CommandPorts, executeCommand } from "./execute.js";
import { parseCommand } from "./parse.js";

function ports(navigated: string[]): CommandPorts {
  return {
    navigate: (path) => {
      navigated.push(path);
<<<<<<< HEAD
    },
    copy: async () => "unavailable",
    items: () => [],
    vaultLocked: () => false,
=======
      return Promise.resolve();
    },
    openPath: () => Promise.resolve({ ok: true }),
    copyPassword: () => Promise.resolve({ ok: false, message: "n/a" }),
    fillPassword: () => Promise.resolve({ ok: false, message: "n/a" }),
    search: () => [],
>>>>>>> 7834b969 (test: split claim navigation tests for quality gate)
  };
}

describe("claim ceremony navigation", () => {
  it("opens the claim ceremony, including a drop by that name", async () => {
    const navigated: string[] = [];
    for (const utterance of [
      "go to claim",
      "open drop",
      "open a claim",
      "/claim",
      "/drop",
    ]) {
      const command = parseCommand(utterance);
      expect(command, utterance).toEqual({
        action: "navigate",
        path: "/claim",
      });
      const outcome = await executeCommand(
        command ?? { action: "help" },
        ports(navigated),
      );
      expect(outcome.ok, utterance).toBe(true);
    }
    expect(navigated).toEqual([
      "/claim",
      "/claim",
      "/claim",
      "/claim",
      "/claim",
    ]);
  });
});
