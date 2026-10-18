import { describe, expect, it } from "vitest";
import { parseCommand } from "./parse.js";
import { PAIR_CLI_COMMAND_PATH } from "./types.js";

describe("parseCommand Pair CLI", () => {
  it("navigates from pair, cli, and their slash forms", () => {
    for (const typed of [
      "pair",
      "cli",
      "pair cli",
      "/pair",
      "/cli",
      "/pair cli",
    ]) {
      expect(parseCommand(typed)).toEqual({
        action: "navigate",
        path: PAIR_CLI_COMMAND_PATH,
      });
    }
  });

  it("refuses the authorize path when Pair CLI is not contributed", () => {
    expect(parseCommand(PAIR_CLI_COMMAND_PATH)).toEqual({
      action: "refuse",
      message: "That path is not an editable document.",
    });
  });
});
