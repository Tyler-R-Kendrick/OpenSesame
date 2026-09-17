/** @vitest-environment jsdom */
import {
  generatePaymentApprovalKeyPair,
  signPaymentApprovalDigest,
} from "@opensesame/wallet-consent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalPaymentApprovalDigest,
  localPaymentApprovalIntent,
} from "./spending-consent.js";
import {
  clearSpendingLeases,
  issueSpendingLease,
  listActiveSpendingLeases,
  listSpendingLeases,
  requestStopSpendingLease,
} from "./spending-leases.js";
import {
  clearSpendingLedgerStorage,
  getSpendingLedger,
  openDemoHouseholdBudget,
  resetSpendingLedgerCache,
} from "./spending-ledger.js";

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

function windowedIntent(
  overrides: Parameters<typeof localPaymentApprovalIntent>[0] = {},
) {
  const now = new Date().toISOString();
  const until = new Date(Date.now() + 3600_000).toISOString();
  return localPaymentApprovalIntent({
    validFrom: now,
    validUntil: until,
    ...overrides,
  });
}

function signedProof(digest: string) {
  const keys = generatePaymentApprovalKeyPair();
  const verifiedBytes = signPaymentApprovalDigest(digest, keys.privateKeyPkcs8);
  return {
    boundDigest: digest,
    verifiedBytes,
    publicKeySpki: keys.publicKeySpki,
  };
}

describe("spending-leases", () => {
  beforeEach(() => {
    ensureLocalStorage();
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
    clearSpendingLeases();
    openDemoHouseholdBudget();
  });

  afterEach(() => {
    clearSpendingLeases();
    clearSpendingLedgerStorage();
    resetSpendingLedgerCache();
  });

  it("refuses forged assurance then issues under a real allocation", async () => {
    const intent = windowedIntent({ amount: "25" });
    const digest = await buildLocalPaymentApprovalDigest(intent);

    const forged = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: {
        boundDigest: digest,
        mechanism: "webauthn",
        assurance: "phishing_resistant",
      },
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) {
      expect(forged.reason).toBe("unverified_assurance");
    }
    expect(listSpendingLeases()).toHaveLength(0);

    const issued = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: signedProof(digest),
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(issued.ok).toBe(true);
    expect(listSpendingLeases()).toHaveLength(1);
  });

  it("refuses a lease that would exceed root available capacity", async () => {
    const intent = windowedIntent({ amount: "5000" });
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const result = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: signedProof(digest),
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("insufficient_available");
    }
  });

  it("refuses reserving an unsigned allocationRef (WAL-B02)", async () => {
    const intent = windowedIntent({ amount: "10", allocationRef: "child-a" });
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const beforeB = getSpendingLedger().project("child-b");
    const result = await issueSpendingLease({
      allocationRef: "child-b",
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: signedProof(digest),
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(result).toEqual({ ok: false, reason: "allocation_mismatch" });
    expect(getSpendingLedger().project("child-b")?.locallyAvailable).toBe(
      beforeB?.locallyAvailable,
    );
    expect(listSpendingLeases()).toHaveLength(0);
  });

  it("refuses replay of the same verifiedBytes (WAL-B03)", async () => {
    const intent = windowedIntent({ amount: "10" });
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const proof = signedProof(digest);
    const first = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof,
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(first.ok).toBe(true);
    const replay = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof,
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("assertion_replay");
  });

  it("refuses a fresh ECDSA signature of an already-spent digest", async () => {
    const intent = windowedIntent({ amount: "10" });
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const first = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: signedProof(digest),
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(first.ok).toBe(true);
    const replay = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: signedProof(digest),
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(replay).toEqual({ ok: false, reason: "assertion_replay" });
  });

  it("refuses already-expired lease windows (WAL-B05)", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const earlier = new Date(Date.now() - 7200_000).toISOString();
    const intent = windowedIntent({
      amount: "5",
      validFrom: earlier,
      validUntil: past,
    });
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const refused = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: signedProof(digest),
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("lease_window_invalid");
  });

  it("listActiveSpendingLeases marks and withholds expired rows (WAL-B05)", async () => {
    const from = new Date(Date.now() - 10_000).toISOString();
    const until = new Date(Date.now() + 60_000).toISOString();
    const intent = windowedIntent({
      amount: "7",
      validFrom: from,
      validUntil: until,
    });
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const issued = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: signedProof(digest),
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(issued.ok).toBe(true);
    const activeNow = listActiveSpendingLeases(Date.now());
    expect(activeNow.some((l) => l.amount === "7")).toBe(true);
    const afterExpiry = listActiveSpendingLeases(Date.now() + 120_000);
    expect(afterExpiry.some((l) => l.amount === "7")).toBe(false);
    expect(listSpendingLeases().some((l) => l.status === "expired")).toBe(true);
  });

  it("requestStopSpendingLease marks an active lease stop_requested", async () => {
    const intent = windowedIntent({ amount: "8" });
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const issued = await issueSpendingLease({
      allocationRef: intent.allocationRef,
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: signedProof(digest),
      validFrom: intent.validFrom,
      validUntil: intent.validUntil,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(requestStopSpendingLease(issued.lease.id)).toBe(true);
    expect(listSpendingLeases()[0]?.status).toBe("stop_requested");
    expect(requestStopSpendingLease(issued.lease.id)).toBe(false);
  });
});
