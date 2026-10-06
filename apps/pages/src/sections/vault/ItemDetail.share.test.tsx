/** @vitest-environment jsdom */
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { planeHookSeams } from "../../bindings/planes.js";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], folders: [] } }),
);
const store = vi.hoisted(() => ({
  toggleFavorite: vi.fn(),
  saveItem: vi.fn(),
  trashItem: vi.fn(),
  restoreItem: vi.fn(),
  purgeItem: vi.fn(),
}));
const listConnections = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => vi.fn(),
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

Object.assign(planeHookSeams, {
  usePlaneStatus: () => ({ host: "live", identity: "connected" }),
});
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
const originalConnectionSeams = { ...connectionSeams };
Object.assign(connectionSeams, { listConnections });
afterAll(() => Object.assign(connectionSeams, originalConnectionSeams));

import { ShareSecretDrop } from "./DropCeremony.js";
import { ItemDetail } from "./ItemDetail.js";
import { makeAccount } from "./account.test-support.js";

function renderAt(itemId: string, search = "") {
  return render(
    <MemoryRouter initialEntries={[`/vault/${itemId}${search}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("sharing an item once, from its toolbar", () => {
  let revoke = () => {};

  let revokeRealm = () => {};
  beforeAll(() => {
    revokeRealm = registerTutorialRealm();
  });
  afterAll(() => revokeRealm());

  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    listConnections.mockResolvedValue([]);
    revoke = registerContributionForTest("secret-share", {
      id: "drop",
      order: 10,
      Panel: ShareSecretDrop,
    });
  });

  afterEach(() => {
    cleanup();
    revoke();
    vi.clearAllMocks();
  });

  const toolbar = () => {
    const bar = document.querySelector(".detail__tools");
    if (!bar) throw new Error("no toolbar");
    return bar;
  };
  const toolbarNames = () =>
    [...toolbar().querySelectorAll("button, a")].map((key) =>
      key.getAttribute("aria-label"),
    );

  it("puts Share beside favorite, edit and delete, and draws no combobox or offer group", () => {
    vault.current = { items: [makeAccount({ id: "itm_login" })], folders: [] };
    renderAt("itm_login");
    expect(toolbarNames()).toEqual([
      "Add to favorites",
      "Edit",
      "Share once",
      "Move to trash",
    ]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.querySelector(".detail__offer")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("opens the ceremony under the fields on press, and a second press closes it", async () => {
    const user = userEvent.setup();
    vault.current = { items: [makeAccount({ id: "itm_login" })], folders: [] };
    renderAt("itm_login");
    const share = screen.getByRole("button", { name: "Share once" });
    expect(share.getAttribute("aria-pressed")).toBe("false");

    await user.click(share);
    expect(share.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("radiogroup", { name: "Opens for" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "1 hour" }),
    );

    await user.click(share);
    expect(share.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("returns the focus to the key on Cancel", async () => {
    const user = userEvent.setup();
    vault.current = { items: [makeAccount({ id: "itm_login" })], folders: [] };
    renderAt("itm_login");
    await user.click(screen.getByRole("button", { name: "Share once" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Share once" }),
    );
  });

  it("arrives open from the list's s key (?share=drop)", () => {
    vault.current = { items: [makeAccount({ id: "itm_login" })], folders: [] };
    renderAt("itm_login", "?share=drop");
    expect(
      screen
        .getByRole("button", { name: "Share once" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("radiogroup", { name: "Opens for" })).toBeTruthy();
  });

  it("draws no key where nothing can be shared: no value, the trash, or sharing off", () => {
    vault.current = {
      items: [
        makeAccount({ id: "itm_empty", password: "", notes: "" }),
        {
          ...makeAccount({ id: "itm_trashed" }),
          deletedAt: "2026-09-01T00:00:00Z",
        },
      ],
      folders: [],
    };
    renderAt("itm_empty");
    expect(screen.queryByRole("button", { name: "Share once" })).toBeNull();
    cleanup();
    renderAt("itm_trashed");
    expect(screen.queryByRole("button", { name: "Share once" })).toBeNull();
    cleanup();

    revoke();
    vault.current = { items: [makeAccount({ id: "itm_login" })], folders: [] };
    renderAt("itm_login");
    expect(screen.queryByRole("button", { name: "Share once" })).toBeNull();
    revoke = () => {};
  });
});
