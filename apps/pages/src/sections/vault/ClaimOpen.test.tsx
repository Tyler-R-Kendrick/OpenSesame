/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimOpenEntry, ClaimOpenLink } from "./ClaimOpen.js";
import { addEntries } from "./add-menu.js";

afterEach(() => {
  cleanup();
});

describe("opening a claim from the vault", () => {
  it("the icon key is a client-side link to the ceremony", async () => {
    render(
      <MemoryRouter initialEntries={["/vault"]}>
        <Routes>
          <Route path="/vault" element={<ClaimOpenLink />} />
          <Route path="/claim" element={<h1>Accept a claim</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Open a claim" });
    expect(link.textContent).toBe("");
    expect(link.querySelector("svg")).not.toBeNull();
    await userEvent.click(link);
    expect(
      screen.getByRole("heading", { name: "Accept a claim" }),
    ).toBeTruthy();
  });

  it("the phone Add menu runs the same navigation", async () => {
    render(
      <MemoryRouter initialEntries={["/vault"]}>
        <Routes>
          <Route path="/vault" element={<ClaimOpenEntry />} />
          <Route path="/claim" element={<h1>Accept a claim</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    const entry = addEntries().find((row) => row.id === "claim");
    expect(entry).toMatchObject({
      label: "Open a claim",
      order: 40,
      slide: undefined,
    });
    entry?.run();
    expect(
      await screen.findByRole("heading", { name: "Accept a claim" }),
    ).toBeTruthy();
  });
});
