import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
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
import { planeHookSeams } from "../../bindings/planes.js";

import type {
  AccountItem,
  CardItem,
  Folder,
  NoteItem,
  PasskeyItem,
  SecretItem,
  VaultItem,
} from "@opensesame/vault-core";
import { manualPassword } from "@opensesame/vault-core";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], folders: [] } }),
);
const store = vi.hoisted(() => ({
  toggleFavorite: vi.fn<(id: string) => Promise<void>>(),
  saveItem: vi.fn<(item: VaultItem) => Promise<void>>(),
  trashItem: vi.fn<(id: string) => Promise<void>>(),
  restoreItem: vi.fn<(id: string) => Promise<void>>(),
  purgeItem: vi.fn<(id: string) => Promise<void>>(),
}));
const copySecret = vi.hoisted(() => vi.fn());
const planes = vi.hoisted(() => ({
  value: { host: "live", identity: "connected" },
}));
const listConnections = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => copySecret,
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

Object.assign(planeHookSeams, { usePlaneStatus: () => planes.value });
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
const originalConnectionSeams = { ...connectionSeams };
Object.assign(connectionSeams, { listConnections });
afterAll(() => Object.assign(connectionSeams, originalConnectionSeams));

import { ItemDetail } from "./ItemDetail.js";
import {
  type AccountSeed,
  makeAccount as makeAccountBase,
} from "./account.test-support.js";

function base<K extends VaultItem["kind"]>(kind: K, id: string, name: string) {
  return {
    id,
    kind,
    name,
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
  };
}

function makeAccount(overrides: AccountSeed = {}): AccountItem {
  return makeAccountBase({
    id: "itm_login",
    password: "hunter2hunter2",
    ...overrides,
  });
}

function savedItem(): VaultItem {
  const item = store.saveItem.mock.calls[0]?.[0];
  if (!item) throw new Error("missing saved vault item");
  return item;
}

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

describe("ItemDetail", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    planes.value = { host: "live", identity: "connected" };
    copySecret.mockResolvedValue("copied");
    listConnections.mockResolvedValue([]);
    store.saveItem.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("explains when the item is not in the vault", () => {
    renderAt("itm_missing");
    expect(screen.getByText(/not in this vault/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Back to the vault/i }),
    ).toBeTruthy();
  });

  it("renders an account with concealed password and reveals it on demand", async () => {
    vault.current = { items: [makeAccount()], folders: [] };
    renderAt("itm_login");
    expect(screen.getByRole("heading", { name: "Webmail" })).toBeTruthy();
    expect(screen.getByText("me@example.com")).toBeTruthy();
    expect(screen.getByText(/Account/)).toBeTruthy();
    expect(screen.queryByText("hunter2hunter2")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /Reveal password/i }),
    );
    expect(screen.getByText("hunter2hunter2")).toBeTruthy();
    expect(screen.getByText(/bits/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Hide password/i }),
    );
    expect(screen.queryByText("hunter2hunter2")).toBeNull();
  });

  it("copies fields through the clipboard feedback", async () => {
    vault.current = { items: [makeAccount()], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Copy username/i }),
    );
    expect(copySecret).toHaveBeenCalledWith("me@example.com");
    expect(
      await screen.findByRole("button", { name: /Copied username/i }),
    ).toBeTruthy();
  });

  it("surfaces clipboard failures", async () => {
    copySecret.mockResolvedValue("unavailable");
    vault.current = { items: [makeAccount()], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Copy username/i }),
    );
    expect(
      await screen.findByRole("button", { name: /Could not copy username/i }),
    ).toBeTruthy();
  });

  it("shows folder membership and update time", () => {
    vault.current = {
      items: [makeAccount({ folderId: "fld_1" })],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
    };
    renderAt("itm_login");
    expect(
      screen.getByRole("link", { name: "Work" }).getAttribute("href"),
    ).toBe("/vault?folder=fld_1");
    expect(screen.getByText(/^Updated /)).toBeTruthy();
  });

  it("lists websites with external links only for browsable URLs", () => {
    vault.current = {
      items: [
        makeAccount({
          uris: [
            { id: "u1", uri: "https://mail.example.com", match: "domain" },
            { id: "u2", uri: "chrome-extension://abc", match: "never" },
            { id: "u3", uri: "*", match: "wildcard" },
          ],
        }),
      ],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByText("https://mail.example.com")).toBeTruthy();
    expect(screen.getByText("Match: mail.example.com")).toBeTruthy();
    expect(screen.queryByText("Match: domain")).toBeNull();
    expect(screen.getByText("*")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Open mail.example.com/i }),
    ).toBeTruthy();
    // Non-browsable schemes get no external link but still render.
    expect(screen.getByText("chrome-extension://abc")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open chrome/ })).toBeNull();
  });

  it("shows the authenticator section and QR reveal for TOTP accounts", async () => {
    vault.current = {
      items: [makeAccount({ totp: "JBSWY3DPEHPK3PXP" })],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByText("Authenticator code")).toBeTruthy();
    expect(
      screen.getByText(/Hidden — shows the otpauth enrollment QR/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Show setup QR/i }),
    );
    expect(
      screen.getByRole("img", {
        name: /Scan to enroll this authenticator secret/,
      }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Hide setup QR/i }),
    );
    expect(
      screen.getByText(/Hidden — shows the otpauth enrollment QR/),
    ).toBeTruthy();
  });

  it("renders custom fields with conceal and copy controls", async () => {
    vault.current = {
      items: [
        makeAccount({
          fields: [
            { id: "f1", name: "API key", value: "ak_123", hidden: true },
            { id: "f2", name: "Region", value: "eu-1", hidden: false },
          ],
        }),
      ],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByText("Custom fields")).toBeTruthy();
    expect(screen.getByText("eu-1")).toBeTruthy();
    expect(screen.queryByText("ak_123")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /Reveal API key/i }),
    );
    expect(screen.getByText("ak_123")).toBeTruthy();
  });

  it("shows notes for non-note items", () => {
    vault.current = {
      items: [makeAccount({ notes: "recovery codes in the safe" })],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByText("recovery codes in the safe")).toBeTruthy();
  });

  it("toggles favorites", async () => {
    vault.current = { items: [makeAccount()], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Add to favorites/i }),
    );
    expect(store.toggleFavorite).toHaveBeenCalledWith("itm_login");
  });

  it("restores or purges a trashed item with confirmation", async () => {
    vault.current = {
      items: [makeAccount({ deletedAt: "2026-08-10T00:00:00Z" })],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByRole("img", { name: "In trash" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Restore$/i }));
    expect(store.restoreItem).toHaveBeenCalledWith("itm_login");

    await userEvent.click(
      screen.getByRole("button", { name: /^Delete permanently$/i }),
    );
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    // Disarm first, then purge for real: the armed trash key asks again.
    await userEvent.click(
      screen.getByRole("button", { name: /Keep this item/i }),
    );
    expect(store.purgeItem).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /^Delete permanently$/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Really delete permanently/i }),
    );
    expect(store.purgeItem).toHaveBeenCalledWith("itm_login");
  });

  it("renders a card with grouped number on reveal", async () => {
    const card: CardItem = {
      ...base("card", "itm_card", "Corporate card"),
      cardholder: "Ada Lovelace",
      brand: "Visa",
      number: "4111111111114242",
      expMonth: "08",
      expYear: "2030",
      code: "123",
    };
    vault.current = { items: [card], folders: [] };
    renderAt("itm_card");
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("•••• •••• •••• 4242")).toBeTruthy();
    expect(screen.getByText("08/2030")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Reveal card number/i }),
    );
    expect(screen.getByText("4111 1111 1111 4242")).toBeTruthy();
  });

  it("renders a secret value and its grantees", async () => {
    const secret: SecretItem = {
      ...base("secret", "itm_secret", "Deploy hook"),
      value: "whsec_123",
      ceiling: [{ id: "g1", action: "http.post", resource: "hook/x" }],
      grantees: ["agt_release_bot"],
      connectionRef: "conn/github/pat",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(screen.getByRole("heading", { name: "Value" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Grantees" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Secret" })).toBeNull();
    const row = screen.getByRole("button", {
      name: "Reveal secret value",
    }).parentElement;
    expect(row?.querySelectorAll("button").length).toBe(3);
    expect(screen.getByText("agt_release_bot")).toBeTruthy();
    expect(
      screen.queryByText(/Capability ceiling|http\.post|hook\/x/),
    ).toBeNull();
    expect(screen.queryByText("Connection reference")).toBeNull();
    expect(
      screen.queryByRole("link", { name: /^Grant or invoke$/i }),
    ).toBeNull();
    expect(listConnections).not.toHaveBeenCalled();
    expect(screen.queryByText("whsec_123")).toBeNull();
  });

  it("shows an empty grantee list and no receipt lookup for secrets", async () => {
    const secret: SecretItem = {
      ...base("secret", "itm_secret", "Loose secret"),
      value: "whsec_123",
      ceiling: [],
      grantees: [],
      connectionRef: "",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(screen.queryByText(/Capability ceiling|No ceiling set/)).toBeNull();
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.queryByText("Connection reference")).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Authorize a connector first/i }),
    ).toBeNull();
  });

  it("never looks up receipts, whatever the Host or connection state", async () => {
    // Pages keeps no Host fetch (ADR 0128): the line is the same whether the
    // Host would have had no connection, been degraded, had no receipts or
    // failed, and nothing is asked of it.
    const sent = vi.spyOn(globalThis, "fetch");
    const worlds = [
      () => listConnections.mockResolvedValue([]),
      () => {
        planes.value = { host: "degraded", identity: "connected" };
      },
      () => {
        listConnections.mockResolvedValue([
          { connectionId: "con_1", connectionRef: "conn/github/pat" },
        ]);
      },
      () => listConnections.mockRejectedValue(new Error("host exploded")),
    ];
    for (const arrange of worlds) {
      arrange();
      vault.current = {
        items: [
          {
            ...base("secret", "itm_secret", "Hook"),
            value: "v",
            ceiling: [],
            grantees: [],
            connectionRef: "conn/github/pat",
          },
        ],
        folders: [],
      };
      const view = renderAt("itm_secret");
      expect(screen.queryByText("Connection reference")).toBeNull();
      view.unmount();
    }
    expect(listConnections).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
  });

  it("updates a secret value through the update panel", async () => {
    const secret: SecretItem = {
      ...base("secret", "itm_secret", "Deploy hook"),
      value: "whsec_123",
      ceiling: [],
      grantees: [],
      connectionRef: "",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    await userEvent.click(
      screen.getByRole("button", { name: /Update secret/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save new value/i }),
    );
    await waitFor(() => expect(store.saveItem).toHaveBeenCalled());
    const saved = savedItem();
    if (saved.kind !== "secret") throw new Error("expected saved secret");
    expect(saved.value).not.toBe("whsec_123");
  });

  it("renders a passkey record", () => {
    const passkey: PasskeyItem = {
      ...base("passkey", "itm_pk", "Example passkey"),
      rpId: "example.com",
      username: "me@example.com",
      credentialIdB64: "Y3JlZA",
      publicKeyB64: "cHVi",
      authenticator: "platform",
      unlocksVault: true,
      custody: "vault",
      privateKeyPkcs8B64: "cHJpdmF0ZQ",
    };
    vault.current = { items: [passkey], folders: [] };
    renderAt("itm_pk");
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByText("OpenSesame synced passkey")).toBeTruthy();
    expect(screen.getByText("Yes, via WebAuthn PRF")).toBeTruthy();
    expect(screen.getByText("OpenSesame synced passkey")).toBeTruthy();
  });

  it("renders a note and its empty fallback", () => {
    const note: NoteItem = {
      ...base("note", "itm_note", "Scratch"),
      notes: "",
    };
    vault.current = { items: [note], folders: [] };
    renderAt("itm_note");
    expect(screen.getByText("This note is empty.")).toBeTruthy();
  });

  it("keeps the list filter when navigating back", () => {
    vault.current = { items: [makeAccount()], folders: [] };
    renderAt("itm_login", "?f=trash");
    const back = screen.getByRole("link", { name: /Back to list/i });
    expect(back.getAttribute("href")).toBe("/vault?f=trash");
  });
});

describe("ItemDetail edge branches", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    planes.value = { host: "live", identity: "connected" };
    copySecret.mockResolvedValue("copied");
    listConnections.mockResolvedValue([]);
    store.saveItem.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders an untitled account without username or password", () => {
    vault.current = {
      items: [
        makeAccount({
          name: "",
          username: "",
          methods: [
            manualPassword("itm_login:password", "", "2026-08-01T00:00:00Z"),
          ],
        }),
        makeAccount({ id: "itm_other", name: "Other" }),
      ],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByRole("heading", { name: "Untitled" })).toBeTruthy();
    // No username row, and the update affordance stands alone.
    expect(screen.queryByText("Username / ID")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Update password/i }),
    ).toBeTruthy();
    expect(screen.queryByText("Authenticator code")).toBeNull();
  });

  it("copies the current TOTP code", async () => {
    vault.current = {
      items: [makeAccount({ totp: "JBSWY3DPEHPK3PXP" })],
      folders: [],
    };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Copy current code/i }),
    );
    await waitFor(() => expect(copySecret).toHaveBeenCalled());
    // Six-digit code, computed locally.
    expect(String(copySecret.mock.calls[0]?.[0])).toMatch(/^\d{6}$/);
  });

  it("shows a passkey with missing optional fields", () => {
    const passkey: PasskeyItem = {
      ...base("passkey", "itm_pk", "Key"),
      rpId: "",
      username: "",
      credentialIdB64: "",
      publicKeyB64: "",
      authenticator: "cross-platform",
      unlocksVault: false,
    };
    vault.current = { items: [passkey], folders: [] };
    renderAt("itm_pk");
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("Security key or another device")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("shows a card with only a number", () => {
    const card: CardItem = {
      ...base("card", "itm_card", "Card"),
      cardholder: "",
      brand: "",
      number: "4111111111111111",
      expMonth: "",
      expYear: "",
      code: "",
    };
    vault.current = { items: [card], folders: [] };
    renderAt("itm_card");
    expect(screen.queryByText("Cardholder")).toBeNull();
    expect(screen.queryByText("Expires")).toBeNull();
    expect(screen.queryByText("Security code")).toBeNull();
    expect(screen.getByText("•••• •••• •••• 1111")).toBeTruthy();
  });

  it("shows a card expiry with only a month", () => {
    const card: CardItem = {
      ...base("card", "itm_card", "Card"),
      cardholder: "",
      brand: "",
      number: "",
      expMonth: "09",
      expYear: "",
      code: "",
    };
    vault.current = { items: [card], folders: [] };
    renderAt("itm_card");
    expect(screen.getByText("09/----")).toBeTruthy();
  });

  it("does not turn a stored connection ref into a grant link", () => {
    const secret: SecretItem = {
      ...base("secret", "itm_secret", "Hook"),
      value: "v",
      ceiling: [],
      grantees: [],
      connectionRef: "bare",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(screen.queryByText("Connection reference")).toBeNull();
    expect(
      screen.queryByRole("link", { name: /^Grant or invoke$/i }),
    ).toBeNull();
  });
});
