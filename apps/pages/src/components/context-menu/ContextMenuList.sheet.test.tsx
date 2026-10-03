import { cleanup, fireEvent, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenuList } from "./ContextMenuList.js";
import type { MenuGroup } from "./menu-model.js";

const shared = vi.fn();
const groups: MenuGroup[] = [
  [
    { id: "open", label: "Open", run: vi.fn() },
    {
      id: "share",
      label: "Share",
      run: vi.fn(),
      submenu: [[{ id: "drop", label: "Temporary drop", run: shared }]],
    },
  ],
];

afterEach(cleanup);

describe("a phone's action sheet", () => {
  it("drills into a submenu: the parent's rows stand down and a back row names it", () => {
    render(
      <ContextMenuList
        groups={groups}
        label="Actions"
        className="ctxmenu ctxmenu--sheet"
        sheet
        onClose={vi.fn()}
      />,
    );
    const list = screen.getByRole("menu", { name: "Actions" });
    expect(list.classList.contains("is-drilled")).toBe(false);
    expect(screen.queryByRole("button", { name: /^Back from/ })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: /Share/ }));
    expect(list.classList.contains("is-drilled")).toBe(true);
    expect(
      screen.getByRole("menuitem", { name: "Temporary drop" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back from Share" }));
    expect(list.classList.contains("is-drilled")).toBe(false);
    expect(
      screen.queryByRole("menuitem", { name: "Temporary drop" }),
    ).toBeNull();
  });

  it("a floating menu keeps its submenu beside the row, with no back row", () => {
    render(
      <ContextMenuList groups={groups} label="Actions" onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Share/ }));
    expect(screen.queryByRole("button", { name: /^Back from/ })).toBeNull();
    expect(
      screen
        .getByRole("menu", { name: "Actions" })
        .classList.contains("is-drilled"),
    ).toBe(false);
  });
});
