/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TravelNoticeMark } from "./TravelNoticeMark.js";

afterEach(cleanup);

describe("TravelNoticeMark", () => {
  it("draws nothing without a notice", () => {
    const { container } = render(<TravelNoticeMark notice={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("says a refusal as a glyph, announced", () => {
    render(
      <TravelNoticeMark notice={{ tone: "err", text: "That is wrong" }} />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("img", { name: "That is wrong" })).toBeTruthy();
  });

  it("joins what happened with what is left, without an alert", () => {
    render(
      <TravelNoticeMark
        notice={{
          tone: "warn",
          text: "1 vault left",
          meta: "1 file could not be",
        }}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("img", { name: "1 vault left · 1 file could not be" }),
    ).toBeTruthy();
  });
});
