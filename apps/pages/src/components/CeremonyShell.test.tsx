/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CeremonyShell } from "./CeremonyShell.js";

afterEach(cleanup);

function renderShell(over: Partial<Parameters<typeof CeremonyShell>[0]> = {}) {
  return render(
    <CeremonyShell
      ok
      top="Reachable"
      name="127.0.0.1:18787"
      facts={[
        { key: "Round trip", value: "12 ms" },
        { key: "Route", value: "direct" },
      ]}
      primary={{ label: "Re-probe", onClick: () => {} }}
      alts={[
        {
          id: "one",
          label: "First alternative",
          icon: null,
          render: () => <p>first body</p>,
        },
        {
          id: "two",
          label: "Second alternative",
          icon: null,
          render: () => <p>second body</p>,
        },
      ]}
      {...over}
    />,
  );
}

describe("CeremonyShell", () => {
  it("states what was found, with its facts", () => {
    renderShell();
    expect(screen.getByText("Reachable")).toBeTruthy();
    expect(screen.getByText("127.0.0.1:18787")).toBeTruthy();
    expect(screen.getByText("Round trip")).toBeTruthy();
    expect(screen.getByText("12 ms")).toBeTruthy();
  });

  it("renders facts as direct dt/dd children of the list", () => {
    // `.found dl` is a two-column grid over direct children, and it is shared
    // with the machine ceremony's card. A wrapper element per pair would
    // silently collapse both layouts into one column.
    const { container } = renderShell();
    const list = container.querySelector("dl");
    const tags = [...(list?.children ?? [])].map((node) => node.tagName);
    expect(tags).toEqual(["DT", "DD", "DT", "DD"]);
  });

  it("keeps every alternative collapsed until asked", () => {
    renderShell();
    expect(screen.queryByText("first body")).toBeNull();
    expect(screen.queryByText("second body")).toBeNull();
  });

  it("expands an alternative in place", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /First alternative/ }));
    expect(screen.getByText("first body")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /First alternative/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("shows one alternative at a time", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /First alternative/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second alternative/ }));
    // Two open sets of controls is the three-buttons-side-by-side problem the
    // ceremony shape exists to remove.
    expect(screen.queryByText("first body")).toBeNull();
    expect(screen.getByText("second body")).toBeTruthy();
  });

  it("closes an open alternative when its row is clicked again", () => {
    renderShell();
    const row = screen.getByRole("button", { name: /First alternative/ });
    fireEvent.click(row);
    fireEvent.click(row);
    expect(screen.queryByText("first body")).toBeNull();
  });

  it("never renders a link — a ceremony that navigates has given up", () => {
    const { container } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: /First alternative/ }));
    expect(container.querySelector("a")).toBeNull();
  });

  it("turns the card amber when the news is bad", () => {
    const { container } = renderShell({ ok: false, top: "Not answering" });
    expect(container.querySelector(".found--attn")).toBeTruthy();
  });

  it("disables the primary while it is busy, and says so", () => {
    const onClick = vi.fn();
    renderShell({
      primary: { label: "Probing…", onClick, busy: true },
    });
    const button = screen.getByRole("button", { name: "Probing…" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("offers a secondary beside the primary when there are two front doors", () => {
    const onSecond = vi.fn();
    renderShell({
      secondary: { label: "Continue as guest", onClick: onSecond },
    });
    // Demoting a daily path into a disclosure costs a click on the path most
    // people take. Two genuine front doors stay peers.
    fireEvent.click(screen.getByRole("button", { name: "Continue as guest" }));
    expect(onSecond).toHaveBeenCalledTimes(1);
  });

  it("draws the primary as the .go square with its verb beside it, never a text slab", () => {
    const { container } = renderShell();
    const key = screen.getByRole("button", { name: "Re-probe" });
    expect(key.className).toBe("go");
    expect(key.getAttribute("title")).toBe("Re-probe");
    // The face is a glyph; the words sit beside it, hidden from the reader
    // that already heard them as the key's name.
    expect(key.textContent).toBe("");
    const verb = container.querySelector(".go-verb");
    expect(verb?.textContent).toBe("Re-probe");
    expect(verb?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".btn")).toBeNull();
  });

  it("draws an ask plain: no wash, an ordinary square with the bin on it, never red", () => {
    const { container } = renderShell({
      ok: false,
      top: undefined,
      primary: { label: "Delete vault", tone: "danger", onClick: () => {} },
    });
    expect(container.querySelector(".found--ask")).toBeTruthy();
    expect(container.querySelector(".found--attn")).toBeNull();
    const key = screen.getByRole("button", { name: "Delete vault" });
    expect(key.className).toBe("go");
    expect(key.querySelector("svg")).toBeTruthy();
    expect(container.querySelector("[class*='--danger']")).toBeNull();
  });

  it("draws a secondary as an icon key beside the primary", () => {
    const more = vi.fn();
    renderShell({
      primary: { label: "Download", onClick: () => {} },
      secondary: { label: "Copy link", onClick: more },
    });
    const key = screen.getByRole("button", { name: "Copy link" });
    expect(key.className).toBe("icon-btn");
    expect(key.textContent).toBe("");
    fireEvent.click(key);
    expect(more).toHaveBeenCalledTimes(1);
  });

  it("keeps the words on a key whose words are the thing chosen", () => {
    renderShell({
      primary: { label: "Recovery key", choice: true, onClick: () => {} },
      secondary: {
        label: "Continue as guest",
        choice: true,
        onClick: () => {},
      },
    });
    const road = screen.getByRole("button", { name: "Continue as guest" });
    expect(road.className).toBe("btn choice");
    expect(road.textContent).toBe("Continue as guest");
    expect(screen.getByRole("button", { name: "Recovery key" }).className).toBe(
      "btn btn--primary choice",
    );
  });

  it("drops the or-rule when there are no alternatives", () => {
    const { container } = renderShell({ alts: [] });
    expect(container.querySelector(".or")).toBeNull();
  });
});
