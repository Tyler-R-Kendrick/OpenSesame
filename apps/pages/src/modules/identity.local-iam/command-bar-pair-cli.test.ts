import {
  NOT_AVAILABLE_MESSAGE,
  executeCommand,
} from "@opensesame/app-core/lib/command-bar/execute.js";
import { parseCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
import {
  slashSections,
  slashSuggestions,
} from "@opensesame/app-core/lib/command-bar/slash.js";
import {
  PAIR_CLI_COMMAND_PATH,
  commandPathAuthorized,
  commandSections,
} from "@opensesame/app-core/lib/command-bar/types.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { describe, expect, it } from "vitest";

// Pair CLI is registered exactly as `identity.local-iam` does in runtime.ts.
const PAIR_CLI = {
  path: PAIR_CLI_COMMAND_PATH,
  label: "Pair CLI",
} as const;

describe("B7-6 Pair CLI command bar", () => {
  it("lists, authorizes, and opens Pair CLI while local IAM contributes the path", async () => {
    const revoke = registerContributionForTest("command-path", PAIR_CLI);
    const command = parseCommand("pair cli");
    expect(command).toEqual({ action: "navigate", path: PAIR_CLI.path });
    expect(commandSections()).toContain(PAIR_CLI.path);
    expect(commandPathAuthorized(PAIR_CLI.path)).toBe(true);

    const navigated: string[] = [];
    if (command === null) throw new Error("expected navigate command");
    const outcome = await executeCommand(command, {
      navigate: (path) => navigated.push(path),
      copy: async () => "copied",
      items: () => [],
      vaultLocked: () => false,
    });
    expect(outcome).toEqual({
      ok: true,
      message: `Opened ${PAIR_CLI.path}`,
    });
    expect(navigated).toEqual([PAIR_CLI.path]);
    revoke();
  });

  it("refuses pair cli when the path is not contributed", async () => {
    const command = parseCommand("pair cli");
    expect(command).toEqual({ action: "navigate", path: PAIR_CLI.path });
    if (command === null) throw new Error("expected navigate command");
    const navigated: string[] = [];
    const outcome = await executeCommand(command, {
      navigate: (path) => navigated.push(path),
      copy: async () => "copied",
      items: () => [],
      vaultLocked: () => false,
    });
    expect(outcome).toEqual({ ok: false, message: NOT_AVAILABLE_MESSAGE });
    expect(navigated).toEqual([]);
  });

  it("lists Pair CLI in slash destinations while the path is contributed", () => {
    const revoke = registerContributionForTest("command-path", PAIR_CLI);
    const rows = slashSections([PAIR_CLI], () => true);
    expect(rows.map((row) => row.path)).toContain(PAIR_CLI.path);
    const suggestion = {
      id: `go:${PAIR_CLI.path}`,
      insert: PAIR_CLI.path,
      label: "Pair CLI",
      run: true,
    };
    for (const typed of ["/pair", "/cli", "/pair cli"]) {
      expect(slashSuggestions(typed, rows, [])).toEqual([suggestion]);
    }
    expect(parseCommand(PAIR_CLI.path)).toEqual({
      action: "navigate",
      path: PAIR_CLI.path,
    });
    revoke();
    expect(parseCommand(PAIR_CLI.path)).toEqual({
      action: "refuse",
      message: "That path is not an editable document.",
    });
  });
});
