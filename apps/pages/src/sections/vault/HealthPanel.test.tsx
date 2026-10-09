import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AccountItem, VaultItem } from "@opensesame/vault-core";

type VaultFixture = { current: { items: VaultItem[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({
    current: { items: [] },
  }),
);

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, { useVault: () => vault.current });
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

import { publishBreachWatch } from "@opensesame/app-core/lib/vault/health.js";
import { HealthPanel } from "./HealthPanel.js";
import {
  type AccountSeed,
  makeAccount as makeAccountBase,
} from "./account.test-support.js";

let seq = 0;

function makeAccount(overrides: AccountSeed = {}): AccountItem {
  seq += 1;
  return makeAccountBase({
    id: `itm_${seq}`,
    name: `Account ${seq}`,
    password: "correct horse battery staple 99!",
    totp: "JBSWY3DPEHPK3PXP",
    passwordChangedAt: new Date().toISOString(),
    ...overrides,
  });
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
    publishBreachWatch({ phase: "off" });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the empty state when nothing is scored", () => {
    renderPanel();
    expect(screen.getByText("No passwords to review")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /New account/i }).getAttribute("href"),
    ).toBe("/vault/new/account");
  });

  it("ignores trashed and password-less accounts", () => {
    vault.current = {
      items: [
        makeAccount({ deletedAt: "2026-08-10T00:00:00Z" }),
        makeAccount({ password: "" }),
      ],
    };
    renderPanel();
    expect(screen.getByText("No passwords to review")).toBeTruthy();
  });

  it("reports a fully clean vault", () => {
    vault.current = { items: [makeAccount()] };
    renderPanel();
    expect(screen.getByText(/1 reviewed · 1 clean/)).toBeTruthy();
    expect(
      screen.getByText(/Every password here is strong, unique/),
    ).toBeTruthy();
  });

  it("counts a password with a pepper slot as unchecked, never as clean or weak", () => {
    const peppered = makeAccount({ id: "itm_pep", name: "Sealed" });
    const method = peppered.methods[0];
    if (method?.type !== "password") throw new Error("fixture");
    vault.current = {
      items: [
        makeAccount(),
        { ...peppered, methods: [{ ...method, pepper: true }] },
      ],
    };
    renderPanel();
    expect(screen.getByText(/1 reviewed · 1 clean/)).toBeTruthy();
    expect(screen.getByText(/· 1 unchecked/)).toBeTruthy();
  });

  it("flags weak, reused, old, and 2FA-less passwords", () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    vault.current = {
      items: [
        makeAccount({
          id: "itm_a",
          name: "Webmail",
          password: "letmein",
          totp: "",
          passwordChangedAt: old,
        }),
        makeAccount({
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
    // Each issue is a StatusMark glyph whose accessible name is the label.
    expect(
      screen.getAllByRole("img", { name: "Reused" }).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByRole("img", { name: "Weak" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("img", { name: "No 2FA" })).toHaveLength(1);
    expect(
      screen.getAllByRole("img", { name: "Over a year old" }),
    ).toHaveLength(1);
    expect(screen.getByText(/no authenticator secret/i)).toBeTruthy();
    expect(screen.getByText(/more than a year/i)).toBeTruthy();
    // Reuse names the other account.
    expect(
      screen.getAllByText(/Also used for Forum|Also used for Webmail/).length,
    ).toBeGreaterThan(0);
    // Findings link through to the item editor.
    expect(
      screen.getAllByRole("link", { name: /^Fix / })[0]?.getAttribute("href"),
    ).toMatch(/\/vault\/itm_[ab]\/edit/);
  });

  it("links back to the vault list", () => {
    renderPanel();
    expect(
      screen.getByRole("link", { name: /All items/i }).getAttribute("href"),
    ).toBe("/vault");
  });

  it("hides breach and two-step results while that capability is off", () => {
    renderPanel();
    expect(
      screen.queryByRole("heading", { name: "Breach and two-step checks" }),
    ).toBeNull();
  });

  it("shows breach and two-step outcomes when the capability has checked", () => {
    vault.current = { items: [makeAccount()] };
    publishBreachWatch({
      phase: "checked",
      label:
        "1 of 1 passwords found in known breaches. 1 login could add an authenticator code.",
      checked: 1,
      breached: 1,
      twoStep: 1,
      lines: [
        {
          id: "itm_gh",
          name: "GitHub",
          site: "github.com",
          breaches: 42,
          twoFactorAvailable: true,
          sentences: [
            "Found in breaches 42 times: change this password",
            "This site takes an authenticator code; none is stored",
          ],
        },
      ],
    });
    renderPanel();
    expect(screen.getByText(/1 reviewed · 1 clean/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Breach and two-step checks" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "1 of 1 passwords found in known breaches. 1 login could add an authenticator code.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Found in breaches 42 times: change this password"),
    ).toBeTruthy();
    expect(
      screen.getByText("This site takes an authenticator code; none is stored"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open breach and two-step checks" })
        .getAttribute("href"),
    ).toBe("/settings/capabilities#feature-security-checks");
    expect(
      screen.getByRole("link", { name: "GitHub" }).getAttribute("href"),
    ).toBe("/vault/itm_gh");
  });
});
