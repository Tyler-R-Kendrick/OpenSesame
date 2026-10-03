import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import { EmptyTip, emptyTips } from "./EmptyTip.js";

describe("EmptyTip", () => {
  afterEach(cleanup);

  it("renders IconInfo guidance with role=note", () => {
    render(<EmptyTip>Press x to explode.</EmptyTip>);
    const tip = screen.getByRole("note");
    expect(tip.textContent).toContain("Press x to explode.");
    expect(tip.className).toContain("empty__tip--keys");
    expect(tip.querySelector("svg")).not.toBeNull();
  });

  it("carries a touch counterpart where a keyboard tip has one", () => {
    // Hidden whole on a phone, a keyboard tip left the empty state bare.
    render(<EmptyTip>{emptyTips.rail}</EmptyTip>);
    const tip = screen.getByRole("note");
    expect(tip.className).toBe("empty__tip");
    expect(tip.querySelector(".empty__tip-keys")?.textContent).toBe(
      emptyTips.rail,
    );
    expect(tip.querySelector(".empty__tip-touch")?.textContent).toBe(
      "The menu key at the top opens every section.",
    );
  });

  it("gives every keyboard tip the finger's own voice", () => {
    // A tip that names a key and has no twin is hidden outright on a phone.
    for (const tip of Object.values(emptyTips)) {
      render(<EmptyTip>{tip}</EmptyTip>);
      const note = screen.getByRole("note");
      expect(note.querySelector(".empty__tip-keys")?.textContent).toBe(tip);
      const touch = note.querySelector(".empty__tip-touch")?.textContent ?? "";
      expect(touch).not.toBe("");
      expect(touch).not.toMatch(/\b(esc|enter|press|keyboard|j\/k)\b/i);
      cleanup();
    }
  });

  it("swaps the help and back tips for the gesture that does the same", () => {
    render(<EmptyTip>{emptyTips.escBack}</EmptyTip>);
    expect(document.querySelector(".empty__tip-touch")?.textContent).toBe(
      "Swipe right to go back.",
    );
    cleanup();
    render(<EmptyTip>{emptyTips.keymap}</EmptyTip>);
    expect(document.querySelector(".empty__tip-touch")?.textContent).toBe(
      "Help in the ⋯ menu lists every gesture.",
    );
  });

  it("can drop the keys class for non-keyboard tips", () => {
    render(<EmptyTip keys={false}>Add a connector first.</EmptyTip>);
    expect(screen.getByRole("note").className).toBe("empty__tip");
  });
});
