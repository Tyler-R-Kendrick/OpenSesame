/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CeremonyRow } from "./CeremonyRow.js";

afterEach(cleanup);

describe("CeremonyRow", () => {
  it("names the thing, states one fact, and ends in its one action", () => {
    render(
      <CeremonyRow
        icon={<svg aria-hidden="true" />}
        label="Leave for a trip"
        sub="2 vaults on this device"
        action={<button type="button">go</button>}
      />,
    );
    expect(screen.getByText("Leave for a trip")).toBeTruthy();
    expect(screen.getByText("2 vaults on this device")).toBeTruthy();
    expect(screen.getByRole("button", { name: "go" })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws a status as a glyph whose sentence is its name", () => {
    render(
      <CeremonyRow
        icon={null}
        label="Store path manifest"
        mark={{ tone: "ok", label: "Saved manifest.json" }}
        sub="3 entries"
        action={null}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Saved manifest.json" }),
    ).toBeTruthy();
  });
});
