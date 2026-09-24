import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import { EmptyTip, emptyTips } from "./EmptyTip.js";

describe("EmptyTip", () => {
  afterEach(cleanup);

  it("renders IconInfo guidance with role=note", () => {
    render(<EmptyTip>{emptyTips.keymap}</EmptyTip>);
    const tip = screen.getByRole("note");
    expect(tip.textContent).toContain(emptyTips.keymap);
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

  it("can drop the keys class for non-keyboard tips", () => {
    render(<EmptyTip keys={false}>Add a connector first.</EmptyTip>);
    expect(screen.getByRole("note").className).toBe("empty__tip");
  });
});
