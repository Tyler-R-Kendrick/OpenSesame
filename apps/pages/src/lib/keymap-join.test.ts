/** @vitest-environment jsdom */
import { JOIN_COMMAND_PATH } from "@opensesame/app-core/lib/command-bar/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeymapHandler } from "./keymap.js";
import { press, resetKeymapDom } from "./keymap.test-harness.js";

afterEach(() => {
  resetKeymapDom();
});

describe("join keymap", () => {
  it("g then j opens join", () => {
    const navigate = vi.fn();
    const handler = createKeymapHandler({ navigate, showHelp: vi.fn() });
    press(handler, "g");
    press(handler, "j");
    expect(navigate).toHaveBeenCalledWith(JOIN_COMMAND_PATH);
  });
});
