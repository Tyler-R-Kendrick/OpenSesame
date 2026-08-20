import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  current: {
    items: [],
    folders: [],
  },
}));
const store = vi.hoisted(() => ({
  toggleFavorite: vi.fn(),
  saveItem: vi.fn(),
  trashItem: vi.fn(),
  restoreItem: vi.fn(),
  purgeItem: vi.fn(),
}));
const copySecret = vi.hoisted(() => vi.fn());
const planes = vi.hoisted(() => ({
  value: { host: "live", identity: "connected" },
}));
const listConnections = vi.hoisted(() => vi.fn());
const connectionEvents = vi.hoisted(() => vi.fn());

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {useVault: () => vault.current,
  useVaultStore: () => store,
  useCopySecret: () => copySecret});


import { planeSeams } from "../../lib/planes.js";
const originalPlaneSeams = { ...planeSeams };
Object.assign(planeSeams, {usePlaneStatus: () => planes.value});
import { connectionSeams } from "../../lib/connections.js";
const originalConnectionSeams = { ...connectionSeams };
Object.assign(connectionSeams, { listConnections, connectionEvents });

import type {
  CardItem,
  LoginItem,
  NoteItem,
  PasskeyItem,
  SecretItem,
  VaultItem,
} from "../../lib/vault/model.js";
import { ItemDetail } from "./ItemDetail.js";

function base(kind: VaultItem["kind"], id: string, name: string) {
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

function makeLogin(overrides: Partial<LoginItem> = {}): LoginItem {
  return {
    ...(overlapCast(base("login", "itm_login", "Webmail"))),
    username: "me@example.com",
    password: "hunter2hunter2",
    totp: "",
    uris: [],
    passwordChangedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
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
    connectionEvents.mockResolvedValue([]);
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

  it("renders a login with concealed password and reveals it on demand", async () => {
    vault.current = {
      items: [makeLogin()],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByRole("heading", { name: "Webmail" })).toBeTruthy();
    expect(screen.getByText("me@example.com")).toBeTruthy();
    expect(screen.getByText(/Login/)).toBeTruthy();
    // Concealed until asked.
    expect(screen.queryByText("hunter2hunter2")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /Reveal password/i }),
    );
    expect(screen.getByText("hunter2hunter2")).toBeTruthy();
    // Strength bar appears once the password is visible.
    expect(screen.getByText(/bits/)).toBeTruthy();
    // Hide again.
    await userEvent.click(
      screen.getByRole("button", { name: /Hide password/i }),
    );
    expect(screen.queryByText("hunter2hunter2")).toBeNull();
  });

  it("copies fields through the clipboard feedback", async () => {
    vault.current = { items: [makeLogin()], folders: [] };
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
    vault.current = { items: [makeLogin()], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Copy username/i }),
    );
    expect(
      await screen.findByRole("button", { name: /Could not copy username/i }),
    ).toBeTruthy();
  });

  it("shows folder membership, sample marker, and update time", () => {
    vault.current = {
      items: [makeLogin({ folderId: "fld_1", sample: true })],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
    };
    renderAt("itm_login");
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("SYNTHETIC")).toBeTruthy();
    expect(screen.getByText(/^Updated /)).toBeTruthy();
  });

  it("lists websites with external links only for browsable URLs", () => {
    vault.current = {
      items: [
        makeLogin({
          uris: [
            { id: "u1", uri: "https://mail.example.com", match: "domain" },
            { id: "u2", uri: "chrome-extension://abc", match: "never" },
          ],
        }),
      ],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByText("https://mail.example.com")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Open mail.example.com/i }),
    ).toBeTruthy();
    // Non-browsable schemes get no external link but still render.
    expect(screen.getByText("chrome-extension://abc")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open chrome/ })).toBeNull();
  });

  it("shows the authenticator section and QR reveal for TOTP logins", async () => {
    vault.current = {
      items: [makeLogin({ totp: "JBSWY3DPEHPK3PXP" })],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByText("Authenticator code")).toBeTruthy();
    // QR hidden until asked.
    expect(
      screen.getByText(/Hidden — shows the otpauth enrollment QR/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Show$/i }));
    expect(screen.getByText(/Scan with an authenticator app/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Hide$/i }));
    expect(
      screen.getByText(/Hidden — shows the otpauth enrollment QR/),
    ).toBeTruthy();
  });

  it("generates a replacement password through the update panel", async () => {
    vault.current = { items: [makeLogin()], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Update password/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save new value/i }),
    );
    await waitFor(() => expect(store.saveItem).toHaveBeenCalled());
    const saved = overlapCast(store.saveItem.mock.calls[0]?.[0]);
    expect(saved.password).not.toBe("hunter2hunter2");
    expect(saved.password).toHaveLength(32);
    expect(saved.passwordChangedAt).not.toBe("2026-08-01T00:00:00Z");
  });

  it("requires a value in provide mode and saves what is typed", async () => {
    vault.current = { items: [makeLogin()], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Update password/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Enter$/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /Save new value/i }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(store.saveItem).not.toHaveBeenCalled();
    await userEvent.type(
      screen.getByPlaceholderText("New password"),
      "typed-secret-value",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save new value/i }),
    );
    await waitFor(() => expect(store.saveItem).toHaveBeenCalled());
    expect((overlapCast(store.saveItem.mock.calls[0]?.[0])).password).toBe(
      "typed-secret-value",
    );
  });

  it("cancels the update panel without saving", async () => {
    vault.current = { items: [makeLogin()], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Update password/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(store.saveItem).not.toHaveBeenCalled();
    // Panel collapses back to the trigger button.
    expect(
      screen.getByRole("button", { name: /Update password/i }),
    ).toBeTruthy();
  });

  it("renders custom fields with conceal and copy controls", async () => {
    vault.current = {
      items: [
        makeLogin({
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
      items: [makeLogin({ notes: "recovery codes in the safe" })],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByText("recovery codes in the safe")).toBeTruthy();
  });

  it("toggles favorites", async () => {
    vault.current = { items: [makeLogin()], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Add to favorites/i }),
    );
    expect(store.toggleFavorite).toHaveBeenCalledWith("itm_login");
  });

  it("moves an item to trash", async () => {
    vault.current = { items: [makeLogin()], folders: [] };
    renderAt("itm_login");
    await userEvent.click(
      screen.getByRole("button", { name: /Move to trash/i }),
    );
    expect(store.trashItem).toHaveBeenCalledWith("itm_login");
  });

  it("restores or purges a trashed item with confirmation", async () => {
    vault.current = {
      items: [makeLogin({ deletedAt: "2026-08-10T00:00:00Z" })],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByText("In trash")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Restore$/i }));
    expect(store.restoreItem).toHaveBeenCalledWith("itm_login");

    await userEvent.click(
      screen.getByRole("button", { name: /Delete permanently/i }),
    );
    expect(screen.getByText(/This cannot be undone/)).toBeTruthy();
    // Cancel first, then purge for real.
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(store.purgeItem).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /Delete permanently/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Purge permanently/i }),
    );
    expect(store.purgeItem).toHaveBeenCalledWith("itm_login");
  });

  it("renders a card with grouped number on reveal", async () => {
    const card: CardItem = {
      ...(overlapCast(base("card", "itm_card", "Corporate card"))),
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

  it("renders a secret with grantees, ceiling, and receipt lookup", async () => {
    listConnections.mockResolvedValue([
      { connectionId: "con_1", connectionRef: "conn/github/pat" },
    ]);
    connectionEvents.mockResolvedValue([
      { kind: "invoke", at: "2026-08-10T10:00:00Z", detail: "200 OK" },
    ]);
    const secret: SecretItem = {
      ...(overlapCast(base("secret", "itm_secret", "Deploy hook"))),
      value: "whsec_123",
      ceiling: [
        {
          id: "g1",
          action: "http.post",
          resource: "https://deploy.example.com/hooks/release",
        },
      ],
      grantees: ["agt_release_bot"],
      connectionRef: "conn/github/pat",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(screen.getByText("agt_release_bot")).toBeTruthy();
    expect(screen.getByText("http.post")).toBeTruthy();
    expect(
      screen.getByText("https://deploy.example.com/hooks/release"),
    ).toBeTruthy();
    expect(
      await screen.findByText("invoke · 2026-08-10T10:00:00Z · 200 OK"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Grant or invoke on the Host/i }),
    ).toBeTruthy();
    // The secret value stays concealed.
    expect(screen.queryByText("whsec_123")).toBeNull();
  });

  it("shows empty ceiling and no-receipt states for secrets", async () => {
    const secret: SecretItem = {
      ...(overlapCast(base(
        "secret",
        "itm_secret",
        "Loose secret",
      ))),
      value: "whsec_123",
      ceiling: [],
      grantees: [],
      connectionRef: "",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(screen.getByText(/No ceiling set/)).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(
      await screen.findByText(/No ConnectionRef on this item/),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Authorize a Host connector first/i }),
    ).toBeTruthy();
  });

  it("reports when the Host has no connection for the ref", async () => {
    listConnections.mockResolvedValue([]);
    const secret: SecretItem = {
      ...(overlapCast(base("secret", "itm_secret", "Deploy hook"))),
      value: "whsec_123",
      ceiling: [],
      grantees: [],
      connectionRef: "conn/github/missing",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(
      await screen.findByText(/No Host connection for this ConnectionRef/),
    ).toBeTruthy();
  });

  it("reports when the Host is disconnected", async () => {
    planes.value = { host: "degraded", identity: "connected" };
    const secret: SecretItem = {
      ...(overlapCast(base("secret", "itm_secret", "Deploy hook"))),
      value: "whsec_123",
      ceiling: [],
      grantees: [],
      connectionRef: "conn/github/pat",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(
      await screen.findByText(/Host disconnected — no receipt/),
    ).toBeTruthy();
    expect(listConnections).not.toHaveBeenCalled();
  });

  it("updates a secret value through the update panel", async () => {
    const secret: SecretItem = {
      ...(overlapCast(base("secret", "itm_secret", "Deploy hook"))),
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
    expect((overlapCast(store.saveItem.mock.calls[0]?.[0])).value).not.toBe(
      "whsec_123",
    );
  });

  it("renders a passkey record", () => {
    const passkey: PasskeyItem = {
      ...(overlapCast(base(
        "passkey",
        "itm_pk",
        "Example passkey",
      ))),
      rpId: "example.com",
      username: "me@example.com",
      credentialIdB64: "Y3JlZA",
      publicKeyB64: "cHVi",
      authenticator: "platform",
      unlocksVault: true,
    };
    vault.current = { items: [passkey], folders: [] };
    renderAt("itm_pk");
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.getByText("Yes, via WebAuthn PRF")).toBeTruthy();
    expect(screen.getByText(/cannot be exported/)).toBeTruthy();
  });

  it("renders a note and its empty fallback", () => {
    const note: NoteItem = {
      ...(overlapCast(base("note", "itm_note", "Scratch"))),
      notes: "",
    };
    vault.current = { items: [note], folders: [] };
    renderAt("itm_note");
    expect(screen.getByText("This note is empty.")).toBeTruthy();
  });

  it("keeps the list filter when navigating back", () => {
    vault.current = { items: [makeLogin()], folders: [] };
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
    connectionEvents.mockResolvedValue([]);
    store.saveItem.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders an untitled login without username or password", () => {
    vault.current = {
      items: [
        makeLogin({ name: "", username: "", password: "", totp: "" }),
        makeLogin({ id: "itm_other", name: "Other" }),
      ],
      folders: [],
    };
    renderAt("itm_login");
    expect(screen.getByRole("heading", { name: "Untitled" })).toBeTruthy();
    // No username row, and the update affordance stands alone.
    expect(screen.queryByText("Username")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Update password/i }),
    ).toBeTruthy();
    expect(screen.queryByText("Authenticator code")).toBeNull();
  });

  it("copies the current TOTP code", async () => {
    vault.current = {
      items: [makeLogin({ totp: "JBSWY3DPEHPK3PXP" })],
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
      ...(overlapCast(base("passkey", "itm_pk", "Key"))),
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
      ...(overlapCast(base("card", "itm_card", "Card"))),
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
      ...(overlapCast(base("card", "itm_card", "Card"))),
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

  it("reports when a connection has no receipts yet", async () => {
    listConnections.mockResolvedValue([
      { connectionId: "con_1", connectionRef: "conn/github/pat" },
    ]);
    connectionEvents.mockResolvedValue([]);
    const secret: SecretItem = {
      ...(overlapCast(base("secret", "itm_secret", "Hook"))),
      value: "v",
      ceiling: [],
      grantees: [],
      connectionRef: "conn/github/pat",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(await screen.findByText("No receipts yet.")).toBeTruthy();
  });

  it("degrades gracefully when the receipt lookup fails", async () => {
    listConnections.mockRejectedValue(new Error("host exploded"));
    const secret: SecretItem = {
      ...(overlapCast(base("secret", "itm_secret", "Hook"))),
      value: "v",
      ceiling: [],
      grantees: [],
      connectionRef: "conn/github/pat",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(
      await screen.findByText(/Host disconnected — no receipt/),
    ).toBeTruthy();
  });

  it("falls back to the generic provider for a bare connection ref", () => {
    const secret: SecretItem = {
      ...(overlapCast(base("secret", "itm_secret", "Hook"))),
      value: "v",
      ceiling: [],
      grantees: [],
      connectionRef: "bare",
    };
    vault.current = { items: [secret], folders: [] };
    renderAt("itm_secret");
    expect(
      screen.getByRole("link", { name: /Grant or invoke on the Host/i }),
    ).toBeTruthy();
  });
});
