/** @vitest-environment jsdom */
import {
  type CredentialItem,
  type Folder,
  type VaultItem,
  createCredential,
  createItem,
} from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], folders: [] } }),
);
const store = vi.hoisted(() => ({
  saveItem: vi.fn<(item: VaultItem) => Promise<void>>(),
}));
const copySecret = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => copySecret,
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

import { ItemDetail } from "./ItemDetail.js";

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/vault/${id}`]}>
      <Routes>
        <Route path="/vault/:itemId" element={<ItemDetail />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const billing = { ...createItem("account", "Billing"), username: "ada" };

function apiKey(accountId: string | null): CredentialItem {
  return createCredential(
    { id: "k1", type: "api-key", key: "ak_secret", header: "X-Api-Key" },
    "Billing · API key",
    accountId,
  );
}

describe("a credential's own page (ADR 0179)", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    copySecret.mockResolvedValue("copied");
    store.saveItem.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("names its account as a link, and draws the header and value rows an account draws", async () => {
    vault.current = { items: [billing, apiKey(billing.id)], folders: [] };
    renderAt("k1");
    expect(
      screen.getByRole("link", { name: "Billing" }).getAttribute("href"),
    ).toBe(`/vault/${billing.id}`);
    expect(screen.getByText("API header")).toBeTruthy();
    expect(screen.getByText("X-Api-Key value")).toBeTruthy();
    expect(screen.queryByText("ak_secret")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Copy x-api-key value" }),
    );
    expect(copySecret).toHaveBeenCalledWith("ak_secret");
  });

  it("says None for a credential kept on its own", () => {
    vault.current = { items: [apiKey(null)], folders: [] };
    renderAt("k1");
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Billing" })).toBeNull();
  });

  it("calls a credential of a trashed account none", () => {
    vault.current = {
      items: [
        { ...billing, deletedAt: "2026-01-01T00:00:00.000Z" },
        apiKey(billing.id),
      ],
      folders: [],
    };
    renderAt("k1");
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("types its kind in the heading's meta, not as a credential", async () => {
    vault.current = { items: [apiKey(null)], folders: [] };
    renderAt("k1");
    await waitFor(() =>
      expect(screen.getAllByText("API key").length).toBeGreaterThan(0),
    );
  });
});
