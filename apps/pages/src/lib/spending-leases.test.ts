/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLocalPaymentApprovalDigest } from "./spending-consent.js";
import {
  clearSpendingLeases,
  issueSpendingLease,
  listActiveSpendingLeases,
  listSpendingLeases,
} from "./spending-leases.js";
import {
  clearSpendingLedgerStorage,
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
    const intent = {
      currency: "TEST",
      amount: "25",
      recipient: "workload-research",
    };
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const now = new Date().toISOString();
    const until = new Date(Date.now() + 3600_000).toISOString();

    const forged = await issueSpendingLease({
      allocationRef: "child-a",
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: {
        boundDigest: digest,
        mechanism: "webauthn",
        assurance: "phishing_resistant",
      },
      validFrom: now,
      validUntil: until,
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) {
      expect(forged.reason).toBe("unverified_assurance");
    }
    expect(listSpendingLeases()).toHaveLength(0);

    const issued = await issueSpendingLease({
      allocationRef: "child-a",
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: {
        boundDigest: digest,
        verifiedBytes: new Uint8Array([1]),
      },
      validFrom: now,
      validUntil: until,
    });
    expect(issued.ok).toBe(true);
    expect(listSpendingLeases()).toHaveLength(1);
  });

  it("refuses a lease that would exceed root available capacity", async () => {
    const intent = {
      currency: "TEST",
      amount: "5000",
      recipient: "workload-research",
    };
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const result = await issueSpendingLease({
      allocationRef: "child-a",
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: {
        boundDigest: digest,
        verifiedBytes: new Uint8Array([1]),
      },
      validFrom: new Date().toISOString(),
      validUntil: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("insufficient_available");
    }
  });

  it("refuses replay of the same verifiedBytes (WAL-B03)", async () => {
    const intent = {
      currency: "TEST",
      amount: "10",
      recipient: "workload-research",
    };
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const now = new Date().toISOString();
    const until = new Date(Date.now() + 3600_000).toISOString();
    const proof = {
      boundDigest: digest,
      verifiedBytes: new Uint8Array([7, 7, 7]),
    };
    const first = await issueSpendingLease({
      allocationRef: "child-a",
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof,
      validFrom: now,
      validUntil: until,
    });
    expect(first.ok).toBe(true);
    const replay = await issueSpendingLease({
      allocationRef: "child-a",
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent: { ...intent, amount: "11" },
      proof: {
        boundDigest: await buildLocalPaymentApprovalDigest({
          ...intent,
          amount: "11",
        }),
        verifiedBytes: new Uint8Array([7, 7, 7]),
      },
      validFrom: now,
      validUntil: until,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("assertion_replay");
  });

  it("refuses already-expired lease windows (WAL-B05)", async () => {
    const intent = {
      currency: "TEST",
      amount: "5",
      recipient: "workload-research",
    };
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const past = new Date(Date.now() - 3600_000).toISOString();
    const earlier = new Date(Date.now() - 7200_000).toISOString();
    const refused = await issueSpendingLease({
      allocationRef: "child-a",
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: { boundDigest: digest, verifiedBytes: new Uint8Array([3]) },
      validFrom: earlier,
      validUntil: past,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("lease_window_invalid");
  });

  it("listActiveSpendingLeases marks and withholds expired rows (WAL-B05)", async () => {
    const intent = {
      currency: "TEST",
      amount: "7",
      recipient: "workload-research",
    };
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const from = new Date(Date.now() - 10_000).toISOString();
    const until = new Date(Date.now() + 60_000).toISOString();
    const issued = await issueSpendingLease({
      allocationRef: "child-a",
      beneficiaryRef: "workload-research",
      grantRef: "grant-demo",
      rootAccountingRef: "household",
      intent,
      proof: { boundDigest: digest, verifiedBytes: new Uint8Array([4, 4]) },
      validFrom: from,
      validUntil: until,
    });
    expect(issued.ok).toBe(true);
    const activeNow = listActiveSpendingLeases(Date.now());
    expect(activeNow.some((l) => l.amount === "7")).toBe(true);
    const afterExpiry = listActiveSpendingLeases(Date.now() + 120_000);
    expect(afterExpiry.some((l) => l.amount === "7")).toBe(false);
    expect(listSpendingLeases().some((l) => l.status === "expired")).toBe(true);
  });
});
