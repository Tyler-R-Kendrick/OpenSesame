import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import { EmptyTip, emptyTips } from "./EmptyTip.js";

describe("EmptyTip", () => {
  afterEach(cleanup);

  it("renders IconInfo guidance with role=note", () => {
    render(<EmptyTip>{emptyTips.navigate}</EmptyTip>);
    const tip = screen.getByRole("note");
    expect(tip.textContent).toContain(emptyTips.navigate);
    expect(tip.className).toContain("empty__tip--keys");
    expect(tip.querySelector("svg")).not.toBeNull();
  });

  it("can drop the keys class for non-keyboard tips", () => {
    render(<EmptyTip keys={false}>Add a connector first.</EmptyTip>);
    expect(screen.getByRole("note").className).toBe("empty__tip");
  });
});
