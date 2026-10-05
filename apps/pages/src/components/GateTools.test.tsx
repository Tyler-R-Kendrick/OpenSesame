/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GateTools } from "./GateTools.js";

afterEach(cleanup);

describe("the keys in a gate screen's corner", () => {
  it("are the theme key and the seat for the help key, side by side", () => {
    const { container } = render(<GateTools />);
    const theme = screen.getByRole("button", { name: /^Theme:/ });
    const seat = container.querySelector(".gate-seat");
    if (!seat) throw new Error("no seat drawn");
    expect(
      theme.compareDocumentPosition(seat) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("takes the theme key out of the Tab order where a screen asks (the door)", () => {
    render(<GateTools tabIndex={-1} />);
    expect(screen.getByRole("button", { name: /^Theme:/ }).tabIndex).toBe(-1);
  });
});
