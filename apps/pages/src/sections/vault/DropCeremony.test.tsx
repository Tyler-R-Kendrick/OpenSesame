import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DropItem,
  LoginItem,
  SecretItem,
  VaultItem,
} from "@opensesame/vault-core";

const store = vi.hoisted(() => ({
  saveItem: vi.fn<(item: VaultItem) => Promise<void>>(),
  purgeItem: vi.fn<(id: string) => Promise<void>>(),
  toggleFavorite: vi.fn<(id: string) => Promise<void>>(),
  trashItem: vi.fn<(id: string) => Promise<void>>(),
  restoreItem: vi.fn<(id: string) => Promise<void>>(),
}));
const createClaim = vi.hoisted(() => vi.fn());
const pollClaim = vi.hoisted(() => vi.fn());

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

const vault: VaultHarness = {
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

import { dropSeams } from "@opensesame/app-core/lib/vault/drop.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVaultStore: () => store,
  useVault: () => vault.current,
});
Object.assign(dropSeams, { createClaim, pollClaim });

import { DropRecordFields, ShareSecretDrop } from "./DropCeremony.js";

function sessionFor(claimId = "clm_test") {
  return {
    claimId,
    bearerToken: `osc_clm_${claimId}.secret`,
    userCode: "ABCD-EFGH",
    verifyUrl: "https://pages.example/OpenSesame/claim",
    expiresAt: "2026-08-30T10:00:00.000Z",
  };
}

function makeSecret(overrides: Partial<SecretItem> = {}): SecretItem {
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

function makeDrop(overrides: Partial<DropItem> = {}): DropItem {
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

function makeAccount(): LoginItem {
  return {
    id: "itm_login",
    kind: "login",
    name: "GitHub",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    username: "octocat",
    password: "hunter2-login",
    totp: "",
    uris: [],
    passwordChangedAt: "2026-08-01T00:00:00Z",
  };
}

beforeEach(() => {
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
  cleanup();
  // beforeEach resets mock state; the seam objects themselves stay injected
  // for the whole file (vitest isolates modules per test file).
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => store,
    useVault: () => vault.current,
  });
  Object.assign(dropSeams, { createClaim, pollClaim });
});

describe("share ceremony on an item", () => {
  it("seals a secret with a TTL and shows the drop card, saving no item", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ShareSecretDrop item={makeSecret()} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Share once/i }));
    const ttl = screen.getByLabelText("Opens for");
    expect(ttl.querySelectorAll("option")).toHaveLength(3);
    expect(screen.queryByRole("checkbox", { name: /Keep a copy/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");

    expect(
      screen.getByText(/#token=osc_clm_clm_test\.secret&key=/),
    ).toBeTruthy();
    expect(screen.getAllByText("ABCD-EFGH").length).toBeGreaterThan(0);
    expect(screen.queryByText("s3cr3t-value")).toBeNull();
    expect(screen.queryByRole("link", { name: /drop record/i })).toBeNull();
    expect(store.saveItem).not.toHaveBeenCalled();

    const [manifest] = createClaim.mock.calls[0] ?? [];
    expect(JSON.stringify(manifest)).not.toContain("s3cr3t-value");
  });

  it("names the key once: the group head is decoration beside it", () => {
    render(
      <MemoryRouter>
        <ShareSecretDrop item={makeSecret()} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText("Share once")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Share once" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Share once" })).toHaveLength(
      1,
    );
  });

  it("moves focus into the ceremony on open and back to the key on Cancel", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ShareSecretDrop item={makeSecret()} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "Share once" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Opens for"));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Share once" }),
    );
  });

  it("opens by keyboard with focus on the first control, and Cancel by keyboard returns it", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ShareSecretDrop item={makeSecret()} />
      </MemoryRouter>,
    );
    screen.getByRole("button", { name: "Share once" }).focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByLabelText("Opens for"));
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Share once" }),
    );
  });

  it("does not take focus when it mounts already open", () => {
    render(
      <MemoryRouter>
        <ShareSecretDrop item={makeSecret()} initialOpen />
      </MemoryRouter>,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it("seals a login password the same way", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ShareSecretDrop item={makeAccount()} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /Share once/i }));
    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");
    expect(store.saveItem).not.toHaveBeenCalled();
    const [manifest] = createClaim.mock.calls[0] ?? [];
    expect(JSON.stringify(manifest)).not.toContain("hunter2-login");
  });
});

describe("disposal", () => {
  it("shows state and countdown on the drop record", () => {
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Waiting to be opened")).toBeTruthy();
    expect(screen.getByText(/left$/)).toBeTruthy();
  });

  it("purges the record when the poll says the drop was opened", async () => {
    pollClaim.mockResolvedValue("consumed");
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(store.purgeItem).toHaveBeenCalledWith("itm_drop"),
    );
  });

  it("keeps the record while the poll is pending", async () => {
    pollClaim.mockResolvedValue("pending");
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    await screen.findByText("Waiting to be opened");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.purgeItem).not.toHaveBeenCalled();
  });
});
