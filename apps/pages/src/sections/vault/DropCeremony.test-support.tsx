import { cleanup, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import { dropSeams } from "@opensesame/app-core/lib/vault/drop.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import type { DropItem, SecretItem, VaultItem } from "@opensesame/vault-core";

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { ShareSecretDrop } from "./DropCeremony.js";

export const store = {
  saveItem: vi.fn<(item: VaultItem) => Promise<void>>(),
  purgeItem: vi.fn<(id: string) => Promise<void>>(),
  toggleFavorite: vi.fn<(id: string) => Promise<void>>(),
  trashItem: vi.fn<(id: string) => Promise<void>>(),
  restoreItem: vi.fn<(id: string) => Promise<void>>(),
};
export const createClaim = vi.fn();
export const pollClaim = vi.fn();

type VaultHarness = {
  current: {
    items: VaultItem[];
    folders: [];
    status: string;
    prefs: {
      autoLockMinutes: number;
      lockOnHide: boolean;
      signOutOnLock: boolean;
      clipboardClearSeconds: number;
      theme: "system";
    };
  };
};

export const vault: VaultHarness = {
  current: {
    items: [],
    folders: [],
    status: "locked",
    prefs: {
      autoLockMinutes: 0,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
      theme: "system",
    },
  },
};

export function sessionFor(claimId = "clm_test") {
  return {
    claimId,
    bearerToken: `osc_clm_${claimId}.secret`,
    userCode: "ABCD-EFGH",
    verifyUrl: "https://pages.example/OpenSesame/claim",
    expiresAt: "2026-08-30T10:00:00.000Z",
  };
}

export function makeSecret(overrides: Partial<SecretItem> = {}): SecretItem {
  return {
    id: "itm_secret",
    kind: "secret",
    name: "Deploy token",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    value: "s3cr3t-value",
    ceiling: [],
    grantees: [],
    connectionRef: "",
    ...overrides,
  };
}

export function makeDrop(overrides: Partial<DropItem> = {}): DropItem {
  return {
    id: "itm_drop",
    kind: "drop",
    name: "Deploy token",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    state: "pending",
    claimId: "clm_test",
    bearerToken: "osc_clm_clm_test.secret",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
}

// The Share once key is a tutorial target `sharing.drops` contributes.
let revokeRealm = () => {};

export function installDropCeremonyHarness() {
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => store,
    useVault: () => vault.current,
  });
  Object.assign(dropSeams, { createClaim, pollClaim });

  beforeAll(() => {
    revokeRealm = registerTutorialRealm();
  });
  afterAll(() => revokeRealm());

  beforeEach(() => {
    clearNotices();
    for (const mock of Object.values(store)) mock.mockReset();
    store.saveItem.mockResolvedValue(undefined);
    store.purgeItem.mockResolvedValue(undefined);
    createClaim.mockReset();
    createClaim.mockImplementation(async () => sessionFor());
    pollClaim.mockReset();
    pollClaim.mockResolvedValue("pending");
    vault.current = {
      items: [],
      folders: [],
      status: "locked",
      prefs: {
        autoLockMinutes: 0,
        lockOnHide: false,
        signOutOnLock: false,
        clipboardClearSeconds: 30,
        theme: "system",
      },
    };
  });

  afterEach(() => {
    clearNotices();
    cleanup();
    // beforeEach resets mock state; the seam objects themselves stay injected
    // for the whole file (vitest isolates modules per test file).
    Object.assign(vaultHooksSeams, {
      useVaultStore: () => store,
      useVault: () => vault.current,
    });
    Object.assign(dropSeams, { createClaim, pollClaim });
  });
}

/** The ceremony as ItemDetail drives it: open or closed, closing by `onClose`. */
export function Ceremony({
  item,
  startOpen = true,
  onClose,
}: {
  item: VaultItem;
  startOpen?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <MemoryRouter>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        toggle
      </button>
      <ShareSecretDrop
        item={item}
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
      />
    </MemoryRouter>
  );
}

export function expiryRow(): string {
  return screen.getByText("Expires").closest(".frow")?.textContent ?? "";
}
