import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoginItem, VaultItem } from "../../lib/vault/model.js";

type VaultFixture = { current: { items: VaultItem[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({
    current: { items: [] },
  }),
);

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, { useVault: () => vault.current });

import { HealthPanel } from "./HealthPanel.js";

let seq = 0;

function makeLogin(overrides: Partial<LoginItem> = {}): LoginItem {
  seq += 1;
  return {
    id: `itm_${seq}`,
    kind: "login",
    name: `Login ${seq}`,
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    sample: false,
    username: "me@example.com",
    password: "correct horse battery staple 99!",
    totp: "JBSWY3DPEHPK3PXP",
    uris: [],
    passwordChangedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <HealthPanel />
    </MemoryRouter>,
  );
}

describe("HealthPanel", () => {
  beforeEach(() => {
    vault.current = { items: [] };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the empty state when nothing is scored", () => {
    renderPanel();
    expect(screen.getByText("No passwords to review")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /New login/i }).getAttribute("href"),
    ).toBe("/vault/new/login");
  });

  it("ignores trashed and password-less logins", () => {
    vault.current = {
      items: [
        makeLogin({ deletedAt: "2026-08-10T00:00:00Z" }),
        makeLogin({ password: "" }),
      ],
    };
    renderPanel();
    expect(screen.getByText("No passwords to review")).toBeTruthy();
  });

  it("reports a fully clean vault", () => {
    vault.current = { items: [makeLogin()] };
    renderPanel();
    expect(screen.getByText("Passwords reviewed")).toBeTruthy();
    expect(
      screen.getByText(/Every password here is strong, unique/),
    ).toBeTruthy();
  });

  it("flags weak, reused, old, and 2FA-less passwords", () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    vault.current = {
      items: [
        makeLogin({
          id: "itm_a",
          name: "Webmail",
          password: "letmein",
          totp: "",
          passwordChangedAt: old,
        }),
        makeLogin({
          id: "itm_b",
          name: "Forum",
          password: "letmein",
          totp: "JBSWY3DPEHPK3PXP",
        }),
      ],
    };
    renderPanel();
    expect(screen.getByText(/items need attention|item needs/)).toBeTruthy();
    // Both share "letmein" → reused on both; the first is also weak/old/no-2fa.
    expect(screen.getAllByText("Reused").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Weak").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/no authenticator secret/i)).toBeTruthy();
    expect(screen.getByText(/more than a year/i)).toBeTruthy();
    // Reuse names the other account.
    expect(
      screen.getAllByText(/Also used for Forum|Also used for Webmail/).length,
    ).toBeGreaterThan(0);
    // Findings link through to the item editor.
    expect(
      screen
        .getAllByRole("link", { name: /Fix this/i })[0]
        ?.getAttribute("href"),
    ).toMatch(/\/vault\/itm_[ab]\/edit/);
  });

  it("links back to the vault list", () => {
    renderPanel();
    expect(
      screen.getByRole("link", { name: /All items/i }).getAttribute("href"),
    ).toBe("/vault");
  });
});
