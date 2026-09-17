import {
  generatePaymentApprovalKeyPair,
  signPaymentApprovalDigest,
} from "@opensesame/wallet-consent";
import {
  redactWalletExport,
  walletExportLeaksCanary,
} from "@opensesame/wallet-consent";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalPaymentApprovalDigest,
  localPaymentApprovalIntent,
} from "./spending-consent.js";
import {
  clearSpendingLedgerStorage,
  getSpendingLedger,
  openDemoHouseholdBudget,
  resetSpendingLedgerCache,
} from "./spending-ledger.js";
import {
  executeApprovedWalletPayment,
  issuePreparedSpend,
  proposeWalletPayment,
  requestWalletLeaseStop,
  resetWalletAgentBroker,
  walletPaymentStatus,
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

async function approvedIssue(proposalId: string, amount: string) {
  const intent = localPaymentApprovalIntent({
    amount,
    recipient: "0xabc",
    allocationRef: "child-a",
  });
  const digest = await buildLocalPaymentApprovalDigest(intent);
  const keys = generatePaymentApprovalKeyPair();
  return issuePreparedSpend({
    proposalId,
    intent,
    proof: {
      boundDigest: digest,
      verifiedBytes: signPaymentApprovalDigest(digest, keys.privateKeyPkcs8),
      publicKeySpki: keys.publicKeySpki,
    },
  });
}

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

  it("proposes then executes only an internally issued ref", async () => {
    const proposed = proposeWalletPayment({
      caller,
      nodeId: "child-a",
      amount: "10",
      destination: "0xabc",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.proposal.settles).toBe(false);
    const issued = await approvedIssue(proposed.proposal.proposalId, "10");
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

  it("refuses a second issue of the same proposal (WAL-D03)", async () => {
    const proposed = proposeWalletPayment({
      caller,
      nodeId: "child-a",
      amount: "10",
      destination: "0xabc",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const first = await approvedIssue(proposed.proposal.proposalId, "10");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const availableBefore =
      getSpendingLedger().project("household")?.locallyAvailable;
    const second = await approvedIssue(proposed.proposal.proposalId, "10");
    expect(second).toEqual({ ok: false, code: "PROPOSAL_ALREADY_ISSUED" });
    const execFirst = executeApprovedWalletPayment({
      caller,
      preparedRef: first.prepared.ref,
      singleUseToken: first.prepared.singleUseToken,
    });
    expect(execFirst).toMatchObject({ ok: true, state: "reserved" });
    expect(getSpendingLedger().project("household")?.locallyAvailable).toBe(
      (availableBefore ?? 0n) - 10n,
    );
  });

  it("refuses issue without a digest-bound proof", async () => {
    const proposed = proposeWalletPayment({
      caller,
      nodeId: "child-a",
      amount: "10",
      destination: "0xabc",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const intent = localPaymentApprovalIntent({
      amount: "10",
      recipient: "0xabc",
      allocationRef: "child-a",
    });
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const unsigned = await issuePreparedSpend({
      proposalId: proposed.proposal.proposalId,
      intent,
      proof: { boundDigest: digest, mechanism: "webauthn" },
    });
    expect(unsigned).toEqual({ ok: false, code: "unverified_assurance" });
  });

  it("refuses charging fees from the transfer allocation (WAL-E26)", async () => {
    const proposed = proposeWalletPayment({
      caller,
      nodeId: "child-a",
      amount: "10",
      destination: "0xabc",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const issued = await approvedIssue(proposed.proposal.proposalId, "10");
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const before = getSpendingLedger().project("household")?.locallyAvailable;
    const refused = executeApprovedWalletPayment({
      caller,
      preparedRef: issued.prepared.ref,
      singleUseToken: issued.prepared.singleUseToken,
      feeAmount: "2",
      chargeFeeFromTransferBudget: true,
    });
    expect(refused).toEqual({ ok: false, code: "FEE_FROM_TRANSFER_REFUSED" });
    expect(getSpendingLedger().project("household")?.locallyAvailable).toBe(
      before,
    );
  });

  it("refuses execute when the service worker updates mid-payment (WAL-B09)", async () => {
    const proposed = proposeWalletPayment({
      caller,
      nodeId: "child-a",
      amount: "10",
      destination: "0xabc",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const issued = await approvedIssue(proposed.proposal.proposalId, "10");
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const refused = executeApprovedWalletPayment({
      caller,
      preparedRef: issued.prepared.ref,
      singleUseToken: issued.prepared.singleUseToken,
      workerState: "activating",
    });
    expect(refused).toEqual({
      ok: false,
      code: "SERVICE_WORKER_UPDATE_REQUIRES_REAUTHORIZATION",
    });
  });

  it("redacts a secret canary from payment status exports (WAL-B17)", () => {
    const canary = "CANARY_wallet_status_export_secret";
    const exported = redactWalletExport({
      ...walletPaymentStatus(),
      secret: canary,
    });
    expect(walletExportLeaksCanary(exported, [canary])).toBe(false);
    expect(exported).not.toContain(canary);
  });

  it("does not expose secret/PAN/sign tools via stop", () => {
    expect(requestWalletLeaseStop({ leaseId: "missing" })).toEqual({
      ok: false,
      code: "LEASE_MISSING",
    });
  });
});
