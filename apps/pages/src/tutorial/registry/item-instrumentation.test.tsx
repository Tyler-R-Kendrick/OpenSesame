/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import type { ItemKindRow } from "@opensesame/app-core/lib/item-kinds.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import { registerGuidePredicates } from "@opensesame/app-core/tutorial/registry/predicates.js";
import {
  isMountedGuideTarget,
  resolveGuideTargetElement,
} from "@opensesame/app-core/tutorial/registry/targets.js";
import type { AccountItem, VaultItem } from "@opensesame/vault-core";
import { VaultRail } from "../../components/VaultRail.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { ShareSecretDrop } from "../../sections/vault/DropCeremony.js";
import { ItemDetail } from "../../sections/vault/ItemDetail.js";
import { TrashCommands } from "../../sections/vault/TrashCommands.js";
import { makeAccount } from "../../sections/vault/account.test-support.js";

/**
 * The controls the item tutorials point at are bound where a person finds
 * them: the pane of an open item, the trash's own keys, and the filters in the
 * rail. A control a tutorial names that is not bound would degrade to text, and
 * `verify:tutorials` would fail on it; this says which one, in milliseconds.
 */
let revokeRealm = () => {};
let revokeShare = () => {};
beforeAll(() => {
  registerGuidePredicates();
  revokeRealm = registerTutorialRealm();
  revokeShare = registerContributionForTest("secret-share", {
    id: "drop",
    order: 10,
    Panel: ShareSecretDrop,
  });
});
afterAll(() => {
  revokeRealm();
  revokeShare();
});

function login(overrides: Partial<AccountItem> = {}): AccountItem {
  return makeAccount({ id: "itm_login", ...overrides });
}

/** The vault the stubbed store hands the panes. */
type StubVault = { items: VaultItem[] };
const state: StubVault = { items: [] };
const store = {
  toggleFavorite: () => undefined,
  trashItem: () => undefined,
  restoreItem: () => undefined,
  purgeItem: () => undefined,
};
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: state.items, folders: [], status: "unlocked" }),
  useVaultStore: () => store,
  useCopySecret: () => async () => "copied",
});

afterEach(() => {
  cleanup();
  state.items = [];
});

function renderPane(item: VaultItem) {
  state.items = [item];
  return render(
    <MemoryRouter initialEntries={[`/vault/${item.id}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("the pane of an open item", () => {
  it("binds the keys of a live account, and the copy keys of what it holds", () => {
    renderPane(login());
    for (const id of [
      "item.favorite",
      "item.edit",
      "item.trash",
      "item.copy-username",
      "item.copy-password",
      "item.share",
    ]) {
      expect(isMountedGuideTarget(id), id).toBe(true);
    }
    expect(resolveGuideTargetElement("item.edit")?.getAttribute("href")).toBe(
      "/vault/itm_login/edit",
    );
    expect(
      resolveGuideTargetElement("item.trash")?.getAttribute("aria-label"),
    ).toBe("Move to trash");
  });

  it("draws no copy key for a field the account does not have", () => {
    renderPane(login({ username: "" }));
    expect(isMountedGuideTarget("item.copy-username")).toBe(false);
    expect(isMountedGuideTarget("item.copy-password")).toBe(true);
  });

  it("binds none of the live keys on an item that is in the trash", () => {
    renderPane(login({ deletedAt: "2026-09-01T00:00:00Z" }));
    for (const id of [
      "item.favorite",
      "item.edit",
      "item.trash",
      "item.credentials.references",
    ]) {
      expect(isMountedGuideTarget(id), id).toBe(false);
    }
  });

  it("lets go of every key when the pane closes", () => {
    const { unmount } = renderPane(login());
    unmount();
    expect(isMountedGuideTarget("item.favorite")).toBe(false);
    expect(isMountedGuideTarget("item.share")).toBe(false);
  });
});

describe("the trash", () => {
  it("binds restore and delete, and they act on nothing from a tutorial", () => {
    const item = login({ deletedAt: "2026-09-01T00:00:00Z" });
    const calls: string[] = [];
    render(
      <TrashCommands
        items={[item]}
        armedId={null}
        onRestore={() => calls.push("restore")}
        onPurge={() => calls.push("purge")}
      />,
    );
    expect(isMountedGuideTarget("trash.restore")).toBe(true);
    expect(isMountedGuideTarget("trash.purge")).toBe(true);
    // Binding a target observes the control; it never presses it.
    expect(calls).toEqual([]);
  });
});

describe("the vault rail", () => {
  const counts = {
    all: 1,
    favorites: 0,
    trash: 0,
    byKind: new Map([["account", 1]]),
    byFolder: new Map<string, number>(),
  };

  function renderRail(kinds: readonly ItemKindRow[]) {
    return render(
      <MemoryRouter initialEntries={["/vault"]}>
        <VaultRail
          items={[login()]}
          folders={[]}
          counts={counts}
          selectedTo="/vault"
          kinds={kinds}
        />
      </MemoryRouter>,
    );
  }

  it("binds the filters, favorites, and logins once the vault holds one", () => {
    renderRail([
      { id: "account", segment: "accounts", label: "Account", order: 0 },
    ]);
    expect(isMountedGuideTarget("vault.filter")).toBe(true);
    expect(isMountedGuideTarget("vault.filter.favorites")).toBe(true);
    expect(isMountedGuideTarget("vault.filter.logins")).toBe(true);
    expect(
      resolveGuideTargetElement("vault.filter.logins")?.getAttribute("href"),
    ).toBe("/vault?f=account");
  });

  it("binds no logins row while the vault holds no login type", () => {
    renderRail([
      { id: "secret", segment: "secrets", label: "Secret", order: 40 },
    ]);
    expect(isMountedGuideTarget("vault.filter.favorites")).toBe(true);
    expect(isMountedGuideTarget("vault.filter.logins")).toBe(false);
  });
});
