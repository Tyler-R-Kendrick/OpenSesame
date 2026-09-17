/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  current: {
    status: "unlocked" as const,
    tomb: "guest",
    guest: true,
    header: null,
    items: [],
    folders: [],
    prefs: {
      theme: "system" as const,
      autoLockMinutes: 0,
      clipboardClearSeconds: 30,
      lockOnHide: false,
      signOutOnLock: false,
    },
    lockedOutUntil: null,
    failedAttempts: 0,
    awaitingSecondStep: false,
    durable: false,
  },
}));

import { vaultHooksSeams } from "../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
});

import {
  clearSpendingLedgerStorage,
  resetSpendingLedgerCache,
} from "../lib/spending-ledger.js";
import { WalletSection } from "./WalletSection.js";

/** Node 22 shadows Storage with an unavailable experimental global. */
function ensureLocalStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
  } satisfies Storage);
}

function renderWallet(route = "/wallet") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <WalletSection />
    </MemoryRouter>,
  );
}

describe("WalletSection", () => {
  beforeEach(() => {
    ensureLocalStorage();
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
    Object.assign(vaultHooksSeams, {
      useVault: () => vault.current,
    });
    vault.current = {
      ...vault.current,
      guest: true,
      tomb: "guest",
    };
  });

  afterEach(() => {
    cleanup();
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
    Object.assign(vaultHooksSeams, originalVaultHooksSeams);
  });

  it("shows an honest empty overview for a guest session", () => {
    renderWallet("/wallet");
    expect(
      screen.getByRole("heading", { name: "No spending balances" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/does not invent amounts or claim offline settlement/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Guest session — Wallet is open locally/i),
    ).toBeTruthy();
    expect(screen.queryByText(/\$\d/)).toBeNull();
    expect(screen.queryByText(/\d+\.\d{2}/)).toBeNull();
  });

  it("labels the temporary card UNAVAILABLE without an issuer", () => {
    renderWallet("/wallet");
    expect(
      screen.getByRole("heading", { name: "Temporary card" }),
    ).toBeTruthy();
    expect(screen.getByText("UNAVAILABLE")).toBeTruthy();
    expect(screen.getByText(/No card issuer is connected/i)).toBeTruthy();
    expect(screen.queryByText(/\d{4}[\s-]?\d{4}/)).toBeNull();
    expect(screen.queryByText(/4111|4242|pan|cvv/i)).toBeNull();
  });

  it("keeps issuer-unavailable copy on payment methods", async () => {
    renderWallet("/wallet/methods");
    expect(
      screen.getByRole("heading", { name: "Payment methods" }),
    ).toBeTruthy();
    expect(screen.getByText("UNAVAILABLE")).toBeTruthy();
    expect(screen.getByText(/does not store PAN or CVV/i)).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Execution adapters" }),
    ).toBeTruthy();
    expect(await screen.findByText("source_inspected")).toBeTruthy();
    expect((await screen.findAllByText("blocked")).length).toBeGreaterThan(0);
    expect(await screen.findByText("fixture_verified")).toBeTruthy();
    expect(screen.getByText("Restricted ERC-20 transfer")).toBeTruthy();
    expect(
      screen.queryByText(/Restricted ERC-20 transfer \(simulation\)/i),
    ).toBeNull();
  });

  it("creates a conserved household budget from Budgets", async () => {
    const user = userEvent.setup();
    renderWallet("/wallet/budgets");
    expect(
      screen.getByRole("heading", { name: "No budgets yet" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /Open demo household budget/i }),
    );
    expect(screen.getByText(/Root budget/i)).toBeTruthy();
    expect(screen.getByText(/ceiling 1000/i)).toBeTruthy();
    expect(
      screen.getByText(/Opened a 1000-subunit shared household budget/i),
    ).toBeTruthy();
  });

  it("shows reserved attempts on Spending passes after sibling demo", async () => {
    const user = userEvent.setup();
    renderWallet("/wallet/budgets");
    await user.click(
      screen.getByRole("button", { name: /Try sibling overspend/i }),
    );
    expect(
      screen.getByText(/First sibling reserved 700; second 400 refused/i),
    ).toBeTruthy();
    cleanup();
    renderWallet("/wallet/passes");
    expect(screen.getByText(/700 on child-a/i)).toBeTruthy();
  });
});
