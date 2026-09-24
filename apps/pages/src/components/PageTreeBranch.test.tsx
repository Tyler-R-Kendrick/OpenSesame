/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { PageTreeNode } from "../lib/page-to-tree.js";
import { PageTreeBranch } from "./PageTreeBranch.js";
import {
  setRailCursor,
  useRailCursor,
  useRailCursorFollowsRoute,
} from "./rail-cursor.js";

afterEach(() => {
  cleanup();
  setRailCursor(null);
});

function node(extra: Partial<PageTreeNode>): PageTreeNode {
  return {
    id: "danger",
    label: "Danger",
    href: "/settings/danger",
    children: [],
    branch: true,
    ...extra,
  };
}

describe("a rail row with nothing under it", () => {
  it("is a place, drawn without a caret or a count", () => {
    render(
      <MemoryRouter>
        <PageTreeBranch node={node({})} level={2} current="/settings" />
      </MemoryRouter>,
    );
    const row = screen.getByRole("treeitem", { name: "Danger" });
    expect(row.hasAttribute("aria-expanded")).toBe(false);
    expect(row.querySelector(".railtree__count")).toBeNull();
  });

  it("stays a directory when it lists records, even none yet", () => {
    render(
      <MemoryRouter>
        <PageTreeBranch
          node={node({ label: "Devices", collection: true })}
          level={2}
          current="/identity"
        />
      </MemoryRouter>,
    );
    const row = screen.getByRole("treeitem", { name: "Devices" });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".railtree__count")?.textContent).toBe("-");
  });
});

function Probe() {
  const tree = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const cursor = useRailCursor();
  useRailCursorFollowsRoute(tree, location.pathname);
  return (
    <>
      <div ref={tree} />
      <output>{cursor ?? "none"}</output>
      <button type="button" onClick={() => navigate("/vault")}>
        go
      </button>
    </>
  );
}

describe("the rail cursor", () => {
  it("is dropped when the page moves while focus is outside the rail", () => {
    render(
      <MemoryRouter initialEntries={["/settings/danger"]}>
        <Probe />
      </MemoryRouter>,
    );
    // The cursor is left on Settings › Danger, then a link in the page
    // (not the rail) moves to the vault: Danger must not stay selected.
    act(() => setRailCursor("rail-settings-danger"));
    expect(screen.getByRole("status").textContent).toBe("rail-settings-danger");
    act(() => screen.getByRole("button", { name: "go" }).click());
    expect(screen.getByRole("status").textContent).toBe("none");
  });
});
