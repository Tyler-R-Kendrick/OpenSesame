import type { CardItem } from "@opensesame/vault-core";
/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
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
  createBudget,
  getSpendingLedger,
  listBudgetRows,
  resetSpendingLedgerCache,
} from "@opensesame/app-core/lib/spending-ledger.js";
import {
  budgetIdForInstrument,
  clearInstrumentBudgets,
} from "@opensesame/app-core/lib/wallet-assignments.js";
import { WalletTree } from "../modules/wallet.spending/WalletTree.js";
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

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
      {location.hash}
    </output>
  );
}

function WalletRail() {
  const { pathname } = useLocation();
  return (
    <aside data-testid="wallet-rail">
      <WalletTree pathname={pathname} />
    </aside>
  );
}

function renderWallet(route = "/wallet", withRail = false) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      {withRail ? <WalletRail /> : null}
      <WalletSection />
      <LocationProbe />
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

  it("opens on the vault workspace without page tabs or cards", () => {
    const { container } = renderWallet("/wallet");
    expect(
      container.querySelector('.record-workspace[data-section="Wallet"]'),
    ).toBeTruthy();
    expect(container.querySelector(".set__nav")).toBeNull();
    expect(container.querySelector(".identity-rows")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Add budget" }).getAttribute("href"),
    ).toBe("/wallet/budgets?new");
    expect(screen.queryByText(/Guest session/i)).toBeNull();
  });

  it("creates, edits, and confirms removal of a budget through record URLs", async () => {
    const user = userEvent.setup();
    renderWallet("/wallet/budgets");
    await user.click(screen.getByRole("link", { name: "Add budget" }));
    expect(screen.getByTestId("location").textContent).toBe(
      "/wallet/budgets?new",
    );
    await user.type(screen.getByLabelText("Name"), "Groceries");
    const ceiling = screen.getByLabelText("Ceiling (subunits)");
    await user.clear(ceiling);
    await user.type(ceiling, "250");
    await user.click(screen.getByRole("button", { name: "Save budget" }));
    const budget = listBudgetRows()[0];
    expect(screen.getByTestId("location").textContent).toBe(
      `/wallet/budgets#${budget?.nodeId}`,
    );
    expect(screen.getByRole("heading", { name: "Groceries" })).toBeTruthy();
    expect(screen.getAllByText("250")).toHaveLength(2);

    await user.click(screen.getByRole("link", { name: "Edit Groceries" }));
    expect(screen.getByTestId("location").textContent).toContain("?edit#");
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Kitchen");
    const editCeiling = screen.getByLabelText("Ceiling (subunits)");
    await user.clear(editCeiling);
    await user.type(editCeiling, "400");
    await user.click(screen.getByRole("button", { name: "Save budget" }));
    expect(screen.getByRole("heading", { name: "Kitchen" })).toBeTruthy();
    expect(listBudgetRows()[0]?.ceiling).toBe(400n);

    await user.click(screen.getByRole("button", { name: "Remove Kitchen" }));
    expect(listBudgetRows()).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: "Confirm remove Kitchen" }),
    );
    expect(listBudgetRows()).toHaveLength(0);
    expect(screen.getByTestId("location").textContent).toBe("/wallet/budgets");
  });

  it("cancels new and edited drafts without changing the ledger", async () => {
    const user = userEvent.setup();
    const budget = createBudget({ name: "Travel", ceiling: 100n });
    renderWallet(`/wallet/budgets?edit#${budget.nodeId}`);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Unsaved");
    await user.click(screen.getByRole("link", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Travel" })).toBeTruthy();
    expect(listBudgetRows()[0]?.label).toBe("Travel");
    await user.click(screen.getByRole("link", { name: "Add budget" }));
    await user.type(screen.getByLabelText("Name"), "Unsaved new");
    await user.click(screen.getByRole("link", { name: "Cancel" }));
    expect(listBudgetRows()).toHaveLength(1);
  });

  it("previews payment methods with concealed vault fields and canonical editor routes", async () => {
    const user = userEvent.setup();
    vault.current = { ...vault.current, items: [cardItem()] };
    renderWallet("/wallet/methods");
    await user.click(screen.getByRole("treeitem", { name: /Corporate card/ }));
    expect(screen.getByTestId("location").textContent).toBe(
      "/wallet/methods#itm_card",
    );
    expect(
      screen.getByRole("heading", { name: "Corporate card" }),
    ).toBeTruthy();
    expect(screen.queryByText("4111 1111 1111 4242")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Reveal card number" }),
    );
    expect(screen.getByText("4111 1111 1111 4242")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Edit" }).getAttribute("href"),
    ).toBe("/vault/itm_card/edit");
    expect(
      screen.getByRole("link", { name: "Add card" }).getAttribute("href"),
    ).toBe("/vault/new/card");
  });

  it("assigns a vault card from a budget draft and changes its budget from method detail", async () => {
    const user = userEvent.setup();
    vault.current = { ...vault.current, items: [cardItem()] };
    renderWallet("/wallet/budgets?new");
    await user.type(screen.getByLabelText("Name"), "Travel");
    const ceiling = screen.getByLabelText("Ceiling (subunits)");
    await user.clear(ceiling);
    await user.type(ceiling, "100");
    await user.click(screen.getByRole("checkbox", { name: "Corporate card" }));
    await user.click(screen.getByRole("button", { name: "Save budget" }));
    expect(screen.getByRole("link", { name: "Corporate card" })).toBeTruthy();
    const budget = listBudgetRows()[0];
    expect(budgetIdForInstrument("itm_card")).toBe(budget?.nodeId);

    cleanup();
    renderWallet("/wallet/methods#itm_card");
    expect(
      screen.getByRole("combobox", { name: "Budget for Corporate card" }),
    ).toHaveProperty("value", budget?.nodeId);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Budget for Corporate card" }),
      "",
    );
    expect(budgetIdForInstrument("itm_card")).toBeNull();
  });

  it("updates the subtree after creation and opens records from the rail", async () => {
    const user = userEvent.setup();
    renderWallet("/wallet/budgets", true);
    const rail = within(screen.getByTestId("wallet-rail"));
    await user.click(rail.getByRole("treeitem", { name: "Budgets" }));
    await user.click(screen.getByRole("link", { name: "Add budget" }));
    await user.type(screen.getByLabelText("Name"), "Travel");
    await user.click(screen.getByRole("button", { name: "Save budget" }));
    const budget = listBudgetRows()[0];
    expect(
      rail.getByRole("treeitem", { name: "Travel" }).getAttribute("href"),
    ).toBe(`/wallet/budgets#${budget?.nodeId}`);
    await user.click(rail.getByRole("treeitem", { name: "Budgets" }));
    expect(rail.queryByRole("treeitem", { name: "Travel" })).toBeNull();
    await user.click(rail.getByRole("treeitem", { name: "Budgets" }));
    await user.click(rail.getByRole("treeitem", { name: "Travel" }));
    expect(screen.getByRole("heading", { name: "Travel" })).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe(
      `/wallet/budgets#${budget?.nodeId}`,
    );
  });

  it("releases only the selected reservation after confirmation", async () => {
    const user = userEvent.setup();
    const budget = createBudget({ name: "Travel", ceiling: 100n });
    const ledger = getSpendingLedger();
    ledger.reserve({ attemptId: "first", nodeId: budget.nodeId, amount: 20n });
    ledger.reserve({ attemptId: "second", nodeId: budget.nodeId, amount: 30n });
    renderWallet("/wallet/passes#attempt%3Afirst");
    expect(screen.getByRole("button", { name: "Release first" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Release first" }));
    expect(ledger.snapshot().attempts.get("first")?.state).toBe("reserved");
    await user.click(
      screen.getByRole("button", { name: "Confirm Release first" }),
    );
    expect(ledger.snapshot().attempts.get("first")?.state).toBe("released");
    expect(ledger.snapshot().attempts.get("second")?.state).toBe("reserved");
    expect(screen.getByTestId("location").textContent).toBe("/wallet/passes");
  });
});
