/** @vitest-environment jsdom */
import {
  registerContributionForTest,
  resetContributionsForTest,
} from "@opensesame/app-core/lib/contributions.js";
import type { DirRow } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultCommands } from "./VaultActions.js";
import { VaultShareSheet, vaultShareGrantParams } from "./VaultShareKey.js";
import { type VaultTreeActions, vaultRowMenu } from "./vault-menu.js";

function withAccess(): void {
  registerContributionForTest("command-path", {
    path: "/access",
    label: "Access",
  });
}

beforeEach(() => {
  resetContributionsForTest();
});
afterEach(() => {
  resetContributionsForTest();
  cleanup();
});

describe("the vault header's Share key", () => {
  it("is drawn when Access is part of the installation, named Share", () => {
    withAccess();
    render(
      <MemoryRouter>
        <VaultCommands />
      </MemoryRouter>,
    );
    const share = screen.getByRole("link", { name: "Share" });
    expect(share.getAttribute("href")).toContain("share=grant");
  });

  it("is absent where no share ledger exists, and never opens a claim", () => {
    render(
      <MemoryRouter>
        <VaultCommands />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("link", { name: /claim/i })).toBeNull();
    for (const link of document.querySelectorAll("a[href*='/claim']")) {
      throw new Error(`vault chrome must not link to /claim: ${link}`);
    }
    expect(document.body.textContent).not.toContain("Open a claim");
    expect(document.body.textContent).not.toContain("Accept a claim");
  });
});

describe("the vault share sheet", () => {
  it("stays shut without the share param", () => {
    render(
      <MemoryRouter initialEntries={["/vault"]}>
        <VaultShareSheet />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on share=grant, a sheet named Share — never a claim route", async () => {
    render(
      <MemoryRouter initialEntries={["/vault?share=grant"]}>
        <VaultShareSheet />
      </MemoryRouter>,
    );
    const sheet = await screen.findByRole("dialog", { name: "Share" });
    expect(sheet).toBeTruthy();
    // No device directory here: the grant form refuses to draw empty.
    expect(
      await screen.findByRole("img", {
        name: "No person or agent on this device can be granted access",
      }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("Accept a claim");
    expect(document.querySelector("a[href*='/claim']")).toBeNull();
  });

  it("offers the temporary drop road when an item is in context", async () => {
    render(
      <MemoryRouter initialEntries={["/vault/itm_1?share=grant"]}>
        <Routes>
          <Route path="/vault/:itemId" element={<VaultShareSheet />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("dialog", { name: "Share" })).toBeTruthy();
    const drop = screen.getByRole("link", { name: "Temporary drop" });
    expect(drop.getAttribute("href")).toBe("/vault/itm_1?share=drop");
  });
});

describe("vaultShareGrantParams", () => {
  it("keeps the listing's own params and adds share=grant", () => {
    const params = new URLSearchParams("f=all&q=deploy");
    expect(vaultShareGrantParams(params)).toBe("f=all&q=deploy&share=grant");
  });

  it("carries a folder prefill", () => {
    const params = new URLSearchParams();
    expect(vaultShareGrantParams(params, { folderId: "fld_1" })).toBe(
      "share=grant&folder=fld_1",
    );
  });
});

describe("a folder's Share menu", () => {
  const dir: DirRow = {
    type: "dir",
    key: "dir_fld_1",
    path: "Work/",
    name: "Work",
    count: 2,
    expanded: false,
  };
  const actions = (): VaultTreeActions => ({
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
    shareFolderGrant: vi.fn(),
    create: vi.fn(),
  });

  it("offers Share → Person or agent when Access is on", () => {
    withAccess();
    const spy = actions();
    const groups = vaultRowMenu(
      dir,
      spy,
      () => undefined,
      () => undefined,
    );
    const share = groups.flat().find((entry) => entry.label === "Share");
    expect(share?.submenu?.flat().map((entry) => entry.label)).toEqual([
      "Person or agent",
    ]);
    share?.submenu?.flat()[0]?.run();
    expect(spy.shareFolderGrant).toHaveBeenCalledWith(dir);
  });

  it("offers no folder Share where Access is off or no handler answers", () => {
    const labels = (row: DirRow, acts: VaultTreeActions) =>
      vaultRowMenu(
        row,
        acts,
        () => undefined,
        () => undefined,
      )
        .flat()
        .map((entry) => entry.label);
    expect(labels(dir, actions())).toEqual(["Expand", "New item"]);
    const { shareFolderGrant: _omitted, ...noHandler } = actions();
    withAccess();
    expect(labels(dir, noHandler)).toEqual(["Expand", "New item"]);
  });
});
