/** @vitest-environment jsdom */
import type { AccountItem } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeContextMenu } from "../../components/context-menu/menu-model.js";
import { VaultTree, vaultTreeSeams } from "./VaultTree.js";
import { makeAccount } from "./account.test-support.js";
import type { VaultTreeActions } from "./vault-menu.js";

Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async () => undefined,
});

function spies(): VaultTreeActions {
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

function holdsSeveral(): AccountItem {
  const base = makeAccount({ id: "itm_many", name: "Billing" });
  return {
    ...base,
    methods: [
      ...base.methods,
      { id: "k", type: "api-key", key: "ak_1", header: "X-Api-Key" },
      { id: "t", type: "token", token: "tok_1", expiresAt: "" },
    ],
  };
}

let actions = spies();
const original = window.matchMedia;

/** A screen that is, or is not, a phone: coarse pointer or narrow. */
function phone(on: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: on && query.includes("coarse"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  actions = spies();
});
afterEach(() => {
  act(() => closeContextMenu());
  cleanup();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: original,
  });
});

function open(item: AccountItem) {
  render(
    <MemoryRouter>
      <VaultTree
        items={[item]}
        folders={[]}
        title="All items"
        total={1}
        actions={actions}
        emptyMessage="Nothing here"
      />
    </MemoryRouter>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: `Actions for ${item.name}` }),
  );
  return screen.getByRole("menu", { name: `Actions for ${item.name}` });
}

describe("a row's Copy asks which credential", () => {
  it("hangs the choices beside the row on a desktop, and copies the one picked", () => {
    phone(false);
    const menu = open(holdsSeveral());
    expect(within(menu).queryByRole("menuitem", { name: "Copy secret" })).toBe(
      null,
    );
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy" }));
    expect(menu.className).not.toContain("is-drilled");
    expect(within(menu).queryByRole("button", { name: /^Back/ })).toBeNull();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "API key as header" }),
    );
    expect(actions.copyCredential).toHaveBeenCalledWith(
      expect.objectContaining({ id: "itm_many" }),
      "k:line",
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("replaces the list with the choices on a phone, with a way back", () => {
    phone(true);
    const menu = open(holdsSeveral());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy" }));
    expect(menu.className).toContain("ctxmenu--drill");
    expect(menu.className).toContain("is-drilled");
    const back = within(menu).getByRole("button", { name: "Back from Copy" });
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Token as bearer" }),
    );
    expect(actions.copyCredential).toHaveBeenCalledWith(
      expect.objectContaining({ id: "itm_many" }),
      "t:line",
    );
    expect(back).toBeTruthy();
  });

  it("goes back to the row's own verbs from the choices", () => {
    phone(true);
    const menu = open(holdsSeveral());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy" }));
    fireEvent.click(
      within(menu).getByRole("button", { name: "Back from Copy" }),
    );
    expect(menu.className).not.toContain("is-drilled");
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toBeTruthy();
  });

  it("is a single named row, with no submenu, when the account holds one credential", () => {
    phone(true);
    const menu = open(makeAccount({ id: "itm_one", name: "Mail" }));
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Copy password" }),
    );
    expect(actions.copyCredential).toHaveBeenCalledWith(
      expect.objectContaining({ id: "itm_one" }),
      expect.stringMatching(/:password$/),
    );
  });
});
