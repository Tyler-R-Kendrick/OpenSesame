/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type CredentialItem,
  type Folder,
  type VaultItem,
  createCredential,
  createItem,
} from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { releaseConnectorOwner } from "../settings/connector-owner.test-support.js";

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
  useCopySecret: () => copySecret,
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

import { ItemDetail } from "./ItemDetail.js";

async function renderAt(id: string) {
  await vaultStore.replaceAll(vault.current.items, vault.current.folders);
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
  let ownerPassword = "";
  beforeEach(async () => {
    const owner = await persistentBrowserOwner();
    ownerPassword = owner.password;
    await vaultStore.unlock(ownerPassword);
    vault.current = { items: [], folders: [] };
    copySecret.mockResolvedValue("copied");
    store.saveItem = vi.spyOn(vaultStore, "saveItem");
  });
  afterEach(async () => {
    cleanup();
    await releaseConnectorOwner();
    vi.restoreAllMocks();
  });

  it("names its account as a link, and draws the header and value rows an account draws", async () => {
    vault.current = { items: [billing, apiKey(billing.id)], folders: [] };
    await renderAt("k1");
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

  it("says None for a credential kept on its own", async () => {
    vault.current = { items: [apiKey(null)], folders: [] };
    await renderAt("k1");
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Billing" })).toBeNull();
  });

  it("calls a credential of a trashed account none", async () => {
    vault.current = {
      items: [
        { ...billing, deletedAt: "2026-01-01T00:00:00.000Z" },
        apiKey(billing.id),
      ],
      folders: [],
    };
    await renderAt("k1");
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("types its kind in the heading's meta, not as a credential", async () => {
    vault.current = { items: [apiKey(null)], folders: [] };
    await renderAt("k1");
    await waitFor(() =>
      expect(screen.getAllByText("API key").length).toBeGreaterThan(0),
    );
  });
  it("keeps bound real credentials outside an actual synthetic session and restores them only after fresh owner authentication", async () => {
    const retired = "controlled-retired-bound-credential";
    const credential = apiKey(billing.id);
    vault.current = { items: [billing, credential], folders: [] };
    await renderAt(credential.id);
    expect(screen.getByRole("link", { name: "Billing" })).toBeTruthy();
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: ownerPassword,
      retiredPassword: retired,
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
    await act(async () => {
      vaultStore.lock();
      await unlockWithRetiredCredentialGate(vaultStore, retired);
    });
    expect(vaultStore.getSnapshot().decoy).toBe(true);
    expect(
      vaultStore
        .getSnapshot()
        .rawItems?.some((item) => item.id === credential.id),
    ).toBe(false);
    expect(screen.queryByRole("link", { name: "Billing" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy x-api-key value" }),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("ak_secret");
    await act(async () => {
      vaultStore.lock();
      await vaultStore.unlock(ownerPassword);
    });
    expect(
      vaultStore
        .getSnapshot()
        .rawItems?.find((item) => item.id === credential.id),
    ).toMatchObject({
      kind: "credential",
      accountId: billing.id,
      method: credential.method,
    });
    expect(screen.getByRole("link", { name: "Billing" })).toBeTruthy();
  });
});
