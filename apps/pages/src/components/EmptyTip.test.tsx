/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EmptyTip, emptyTipKeys, emptyTips, touchTips } from "./EmptyTip.js";

const KEYS = emptyTipKeys;

describe("EmptyTip", () => {
  afterEach(cleanup);

  it("renders IconInfo guidance with role=note", () => {
    render(<EmptyTip>Press x to explode.</EmptyTip>);
    const tip = screen.getByRole("note");
    expect(tip.textContent).toContain("Press x to explode.");
    expect(tip.className).toContain("empty__tip--keys");
    expect(tip.querySelector("svg")).not.toBeNull();
  });

  it("carries both voices where the call site names a tip", () => {
    // Hidden whole on a phone, a keyboard tip left the empty state bare.
    render(<EmptyTip tip="rail" />);
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
    expect(Object.keys(touchTips).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) {
      render(<EmptyTip tip={key} />);
      const note = screen.getByRole("note");
      expect(note.querySelector(".empty__tip-keys")?.textContent).toBe(
        emptyTips[key],
      );
      const touch = note.querySelector(".empty__tip-touch")?.textContent ?? "";
      expect(touch).not.toBe("");
      expect(touch).not.toMatch(/\b(esc|enter|press|keyboard|j\/k)\b/i);
      cleanup();
    }
  });

  it("swaps the help and back tips for the gesture that does the same", () => {
    render(<EmptyTip tip="escBack" />);
    expect(document.querySelector(".empty__tip-touch")?.textContent).toBe(
      "Swipe right to go back.",
    );
    cleanup();
    render(<EmptyTip tip="keymap" />);
    expect(document.querySelector(".empty__tip-touch")?.textContent).toBe(
      "Gestures in the ⋯ menu lists every gesture.",
    );
  });

  it("can drop the keys class for non-keyboard tips", () => {
    render(<EmptyTip keys={false}>Add a connector first.</EmptyTip>);
    expect(screen.getByRole("note").className).toBe("empty__tip");
  });
});
