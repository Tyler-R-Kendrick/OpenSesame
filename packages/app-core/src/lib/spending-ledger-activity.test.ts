/** @vitest-environment jsdom */
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_PATH,
  activitySeams,
  listActivityEvents,
} from "./activity-log.js";
import { kvDelete } from "./kv.js";
import {
  clearSpendingLedgerStorage,
  createBudget,
  getSpendingLedger,
  resetSpendingLedgerCache,
} from "./spending-ledger.js";
import {
  INDEX_PATH,
  PERSONAL_TOMB,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "./vfs.js";

function stubLocalStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
  } satisfies Storage);
}

async function walletEvents(): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const events = await listActivityEvents(PERSONAL_TOMB);
  return events
    .filter((event) => event.category === "wallet")
    .map((event) => event.summary);
}

/**
 * Activity listed "Wallet budget updated" three times beside a Wallet that
 * said "No budgets yet": the ledger is written back whenever it is read,
 * and every write was logged as an update.
 */
describe("wallet budget activity", () => {
  beforeEach(async () => {
    stubLocalStorage();
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, ACTIVITY_LOG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    activitySeams.activeTomb = () => PERSONAL_TOMB;
  });

  afterEach(() => {
    activitySeams.activeTomb = () => null;
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
    vi.unstubAllGlobals();
  });

  it("logs nothing when an empty ledger is only read", async () => {
    getSpendingLedger().transact(() => {});
    expect(await walletEvents()).toEqual([]);
  });

  it("logs a budget that was actually created", async () => {
    createBudget({ name: "Groceries", ceiling: 250n });
    // The sealed activity write is asynchronous and a loaded CI runner can
    // take longer than the settle above, so wait for the event rather than
    // for a fixed time (it failed on CI with `[]`).
    await vi.waitFor(
      async () => {
        expect(await walletEvents()).toEqual(["Wallet budget updated"]);
      },
      { timeout: 5000, interval: 50 },
    );
  });
});
