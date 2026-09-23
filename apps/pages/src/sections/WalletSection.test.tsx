import type { CardItem } from "@opensesame/vault-core";
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
    // SAFETY: fixture constructed in this test matches the declared contract.
    items: [] as CardItem[],
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
} from "@opensesame/app-core/lib/spending-ledger.js";
import { clearInstrumentBudgets } from "@opensesame/app-core/lib/wallet-assignments.js";
import { WalletSection } from "./WalletSection.js";

function cardItem(name = "Corporate card"): CardItem {
  return {
    id: "itm_card",
    kind: "card",
    name,
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    cardholder: "Ada",
    brand: "Visa",
    number: "4111111111114242",
    expMonth: "08",
    expYear: "2030",
    code: "123",
  };
}

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
    clearInstrumentBudgets();
    Object.assign(vaultHooksSeams, {
      useVault: () => vault.current,
    });
    vault.current = {
      ...vault.current,
      guest: true,
      tomb: "guest",
      items: [],
    };
  });

  afterEach(() => {
    cleanup();
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
    clearInstrumentBudgets();
    Object.assign(vaultHooksSeams, originalVaultHooksSeams);
  });

  it("opens on budgets without explainer copy", () => {
    renderWallet("/wallet");
    expect(screen.getByRole("heading", { name: "Budgets" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "No budgets yet" }),
    ).toBeTruthy();
    expect(screen.queryByText(/does not invent amounts/i)).toBeNull();
    expect(screen.queryByText(/Guest session/i)).toBeNull();
    expect(screen.queryByText(/What Wallet manages/i)).toBeNull();
  });

  it.skip("adds, edits, and removes a budget", async () => {
    const user = userEvent.setup();
    renderWallet("/wallet/budgets");
    expect(
      screen.getByRole("heading", { name: "No budgets yet" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add budget" }));
    await user.type(screen.getByLabelText("Name"), "Groceries");
    const ceiling = screen.getByLabelText("Ceiling (subunits)");
    await user.clear(ceiling);
    await user.type(ceiling, "250");
    await user.click(screen.getByRole("button", { name: "Create budget" }));
    expect(screen.getByText("Groceries")).toBeTruthy();
    expect(screen.getByText(/250 · 250 left/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Kitchen");
    const editCeiling = screen.getByLabelText("Ceiling (subunits)");
    await user.clear(editCeiling);
    await user.type(editCeiling, "400");
    await user.click(screen.getByRole("button", { name: "Save budget" }));
    expect(screen.getByText("Kitchen")).toBeTruthy();
    expect(screen.getByText(/400 · 400 left/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove Kitchen" }));
    expect(
      screen.getByRole("heading", { name: "No budgets yet" }),
    ).toBeTruthy();
  });

  it("lists vault cards as payment methods and opens the vault editor to add one", () => {
    vault.current = { ...vault.current, items: [cardItem()] };
    renderWallet("/wallet/methods");
    expect(
      screen.getByRole("link", { name: "Corporate card" }).getAttribute("href"),
    ).toBe("/vault/itm_card");
    expect(screen.getByText(/Card · Visa · •••• 4242/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Add card" }).getAttribute("href"),
    ).toBe("/vault/new/card");
  });

  it.skip("assigns a vault card to a budget from either side", async () => {
    const user = userEvent.setup();
    vault.current = { ...vault.current, items: [cardItem()] };
    renderWallet("/wallet/budgets");
    await user.click(screen.getByRole("button", { name: "Add budget" }));
    await user.type(screen.getByLabelText("Name"), "Travel");
    const ceiling = screen.getByLabelText("Ceiling (subunits)");
    await user.clear(ceiling);
    await user.type(ceiling, "100");
    await user.click(screen.getByRole("checkbox", { name: "Corporate card" }));
    await user.click(screen.getByRole("button", { name: "Create budget" }));
    expect(screen.getByText(/Travel/)).toBeTruthy();
    expect(screen.getByText(/Corporate card/)).toBeTruthy();

    cleanup();
    renderWallet("/wallet/methods");
    expect(
      screen.getByRole("combobox", { name: "Budget for Corporate card" }),
    ).toHaveProperty("value");
    expect(
      // SAFETY: fixture constructed in this test matches the declared contract.
      (
        screen.getByRole("combobox", {
          name: "Budget for Corporate card",
        }) as HTMLSelectElement
      ).selectedOptions[0]?.textContent,
    ).toBe("Travel");
  });
});
