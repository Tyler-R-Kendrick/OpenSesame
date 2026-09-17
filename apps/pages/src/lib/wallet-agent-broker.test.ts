/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSpendingLedgerStorage,
  openDemoHouseholdBudget,
  resetSpendingLedgerCache,
} from "./spending-ledger.js";
import {
  executeApprovedWalletPayment,
  issuePreparedSpend,
  proposeWalletPayment,
  requestWalletLeaseStop,
  resetWalletAgentBroker,
} from "./wallet-agent-broker.js";

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

const caller = { principalRef: "principal-owner" };

describe("wallet-agent-broker", () => {
  beforeEach(() => {
    ensureLocalStorage();
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
    resetWalletAgentBroker();
    openDemoHouseholdBudget();
  });

  afterEach(() => {
    resetWalletAgentBroker();
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
  });

  it("ignores payload identity claims that do not match the caller", () => {
    const result = proposeWalletPayment({
      caller,
      nodeId: "child-a",
      amount: "10",
      destination: "0xabc",
      claimedPrincipalRef: "forged-principal",
    });
    expect(result).toEqual({ ok: false, code: "CALLER_NOT_AUTHORIZED" });
  });

  it("refuses caller-constructed prepared refs", () => {
    const result = executeApprovedWalletPayment({
      caller,
      preparedRef: "prepared:forged",
      singleUseToken: "tok-forged",
    });
    expect(result).toEqual({ ok: false, code: "PREPARED_REF_INVALID" });
  });

  it("proposes then executes only an internally issued ref", () => {
    const proposed = proposeWalletPayment({
      caller,
      nodeId: "child-a",
      amount: "10",
      destination: "0xabc",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.proposal.settles).toBe(false);
    const issued = issuePreparedSpend({
      proposalId: proposed.proposal.proposalId,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const executed = executeApprovedWalletPayment({
      caller,
      preparedRef: issued.prepared.ref,
      singleUseToken: issued.prepared.singleUseToken,
    });
    expect(executed).toMatchObject({ ok: true, state: "reserved" });
    const replay = executeApprovedWalletPayment({
      caller,
      preparedRef: issued.prepared.ref,
      singleUseToken: issued.prepared.singleUseToken,
    });
    expect(replay).toEqual({ ok: false, code: "PREPARED_REF_INVALID" });
  });

  it("does not expose secret/PAN/sign tools via stop", () => {
    expect(requestWalletLeaseStop({ leaseId: "missing" })).toEqual({
      ok: false,
      code: "LEASE_MISSING",
    });
  });
});
