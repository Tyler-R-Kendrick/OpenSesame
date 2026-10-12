/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultTree, vaultTreeSeams } from "./VaultTree.js";
import { makeAccount } from "./account.test-support.js";
import { makeNote } from "./section-items.test-support.js";
import type { VaultTreeActions } from "./vault-menu.js";

Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async () => undefined,
});

const work: Folder = {
  id: "fld_work",
  name: "Work",
  createdAt: "2026-08-01T00:00:00Z",
};
const home: Folder = {
  id: "fld_home",
  name: "Home",
  createdAt: "2026-08-01T00:00:00Z",
};

function actions(): VaultTreeActions {
  return {
    open: vi.fn(),
    preview: vi.fn(),
    copySecret: vi.fn(),
    copyCredential: vi.fn(),
    copyUsername: vi.fn(),
    edit: vi.fn(),
    trash: vi.fn(),
    favorite: vi.fn(),
    share: vi.fn(),
    shareGrant: vi.fn(),
    create: vi.fn(),
  };
}

function draw(items: VaultItem[], folders: Folder[]) {
  render(
    <MemoryRouter>
      <VaultTree
        items={items}
        folders={folders}
        title="All items"
        total={items.length}
        actions={actions()}
        emptyMessage="Nothing here"
      />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("vault tree guide", () => {
  it("keeps each open folder's guide inside that folder's items", () => {
    draw(
      [
        makeAccount({ id: "a", name: "Alpha", folderId: work.id }),
        makeNote({ id: "b", name: "Beta", folderId: work.id }),
        makeNote({ id: "c", name: "Gamma", folderId: home.id }),
        makeNote({ id: "d", name: "Rooted", folderId: null }),
      ],
      [work, home],
    );
    const tree = screen.getByRole("tree", { name: "Vault items" });
    const workRow = screen.getByRole("treeitem", { name: /^Work / });
    const homeRow = screen.getByRole("treeitem", { name: /^Home / });
    const guides = tree.querySelectorAll(".vtree__kids");
    expect(guides).toHaveLength(2);

    const workGuide = workRow.nextElementSibling;
    expect(workGuide).toBe(guides[0]);
    expect(workGuide?.contains(workRow)).toBe(false);
    expect(workGuide?.textContent).toContain("Alpha");
    expect(workGuide?.textContent).toContain("Beta");
    expect(workGuide?.textContent).not.toContain("Gamma");
    expect(workGuide?.textContent).not.toContain("Home");
    expect(workGuide?.textContent).not.toContain("Rooted");
    expect(workGuide?.nextElementSibling).toBe(homeRow);

    const homeGuide = homeRow.nextElementSibling;
    expect(homeGuide).toBe(guides[1]);
    expect(homeGuide?.textContent).toContain("Gamma");
    expect(homeGuide?.textContent).not.toContain("Alpha");
    expect(homeGuide?.nextElementSibling?.textContent).toContain("Rooted");
  });

  it("drops a folder's guide when the folder is collapsed", () => {
    draw([makeNote({ id: "b", name: "Beta", folderId: work.id })], [work]);
    expect(document.querySelector(".vtree__kids")).not.toBeNull();
    fireEvent.click(screen.getByRole("treeitem", { name: /^Work / }));
    expect(document.querySelector(".vtree__kids")).toBeNull();
    expect(screen.getByRole("treeitem", { name: /^Work / })).toBeTruthy();
  });

  it("draws no guide when nothing is nested", () => {
    draw([makeNote({ id: "d", name: "Rooted" })], []);
    expect(document.querySelector(".vtree__kids")).toBeNull();
  });

  it("does not paint the guide as a border on each child row", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../vault.css"),
      "utf8",
    );
    const child = css.match(/\.vtree__row--child\s*\{([^}]*)\}/g) ?? [];
    expect(child.length).toBeGreaterThan(0);
    for (const rule of child) expect(rule).not.toContain("border-left");
    const guide = css.match(/\.vtree__kids::before\s*\{([^}]*)\}/);
    expect(guide?.[1]).toMatch(/top:\s*0\.35rem/);
    expect(guide?.[1]).toMatch(/bottom:/);
  });
});
