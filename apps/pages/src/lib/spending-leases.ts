/**
 * Browser-local spending leases (ADR 0123).
 *
 * A lease redistributes an existing allocation — it never mints budget.
 * Issuance requires a digest-bound approval assessment that refuses forged
 * assurance. Same-origin only; not independent execution enforcement.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { SpendingLeaseStatus } from "@opensesame/os-domain/wallet";
import {
  type DigestBoundApprovalRefusal,
  type DigestBoundPaymentProof,
  type LocalPaymentApprovalIntent,
  assessLocalPaymentApproval,
  buildLocalPaymentApprovalDigest,
} from "./spending-consent.js";
import { getSpendingLedger } from "./spending-ledger.js";
import {
  onWalletTombChange,
  readWalletStorage,
  walletStorageKey,
  walletStorageTomb,
} from "./wallet-storage-scope.js";

const STORAGE_KEY = "opensesame.wallet.leases.v1";

function leaseKey(): string {
  return walletStorageKey(STORAGE_KEY);
}

export type LeaseRecord = {
  readonly id: string;
  readonly grantRef: string;
  readonly allocationRef: string;
  readonly policyVersion: string;
  readonly beneficiaryRef: string;
  readonly proofKeyThumbprint: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly requiredEnforcementDigest: string;
  readonly effectiveEnforcementDigest: string;
  readonly rootAccountingRef: string;
  readonly status: SpendingLeaseStatus;
  readonly amount: string;
  readonly currency: string;
  readonly recipient: string;
  readonly approvalDigest: string;
  readonly reserveAttemptId: string;
};

let cache: LeaseRecord[] | null = null;
let cacheTomb = "";

/**
 * Follow the active tomb: a switch drops the process cache so a guest never
 * reads the personal vault's leases. Subscribed by the `wallet.spending`
 * runtime while it is active (never at import), and the cache is keyed by
 * tomb as well, so a read after an unobserved switch still misses.
 */
export function watchSpendingLeaseScope(): () => void {
  return onWalletTombChange(() => {
    cache = null;
    cacheTomb = "";
  });
}

/** Remember `rows` against the tomb they were read for. */
function cacheRows(rows: LeaseRecord[]): LeaseRecord[] {
  const tomb = walletStorageTomb();
  cache = rows;
  cacheTomb = tomb;
  return rows;
}

function parseStatus(value: BoundaryValue): SpendingLeaseStatus | undefined {
  if (
    value === "active" ||
    value === "stop_requested" ||
    value === "revocation_pending" ||
    value === "revoked" ||
    value === "expired"
  ) {
    return value;
  }
  return undefined;
}

const LEASE_STRING_FIELDS = [
  "id",
  "grantRef",
  "allocationRef",
  "policyVersion",
  "beneficiaryRef",
  "proofKeyThumbprint",
  "validFrom",
  "validUntil",
  "requiredEnforcementDigest",
  "effectiveEnforcementDigest",
  "rootAccountingRef",
  "amount",
  "currency",
  "recipient",
  "approvalDigest",
  "reserveAttemptId",
] as const;

function parseLease(value: BoundaryValue): LeaseRecord | undefined {
  if (!isJsonObject(value)) return undefined;
  const status = parseStatus(value.status);
  if (status === undefined) return undefined;
  const strings = {
    id: "",
    grantRef: "",
    allocationRef: "",
    policyVersion: "",
    beneficiaryRef: "",
    proofKeyThumbprint: "",
    validFrom: "",
    validUntil: "",
    requiredEnforcementDigest: "",
    effectiveEnforcementDigest: "",
    rootAccountingRef: "",
    amount: "",
    currency: "",
    recipient: "",
    approvalDigest: "",
    reserveAttemptId: "",
  } satisfies Record<(typeof LEASE_STRING_FIELDS)[number], string>;
  for (const key of LEASE_STRING_FIELDS) {
    const field = value[key];
    if (!isString(field)) return undefined;
    strings[key] = field;
  }
  return { ...strings, status };
}

function readAll(): LeaseRecord[] {
  const tomb = walletStorageTomb();
  if (cache !== null && cacheTomb === tomb) return cache;
  try {
    const text = readWalletStorage(STORAGE_KEY);
    if (text === null || text === "") return cacheRows([]);
    const parsed: BoundaryValue = overlapCast(JSON.parse(text));
    if (!Array.isArray(parsed)) return cacheRows([]);
    const rows: LeaseRecord[] = [];
    for (const entry of parsed) {
      const row = parseLease(entry);
      if (row !== undefined) rows.push(row);
    }
    return cacheRows(rows);
  } catch {
    return cacheRows([]);
  }
}

function writeAll(rows: readonly LeaseRecord[]): void {
  const next = cacheRows([...rows]);
  try {
    localStorage.setItem(leaseKey(), JSON.stringify(next));
  } catch {
    // Keep memory copy if storage is unavailable.
  }
}

export function listSpendingLeases(): readonly LeaseRecord[] {
  return readAll();
}

const SPENT_ASSERTIONS_KEY = "opensesame.wallet.spent-assertions.v1";

function assertionFingerprint(digest: string): string {
  return digest;
}

function readSpentAssertions(): Set<string> {
  try {
    const raw = readWalletStorage(SPENT_ASSERTIONS_KEY);
    if (raw === null || raw === "") return new Set();
    const parsed: BoundaryValue = overlapCast(JSON.parse(raw));
    if (!Array.isArray(parsed)) return new Set();
    const ids: string[] = [];
    for (const item of parsed) {
      if (isString(item)) ids.push(item);
    }
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function markAssertionSpent(fp: string): void {
  const next = readSpentAssertions();
  next.add(fp);
  localStorage.setItem(
    walletStorageKey(SPENT_ASSERTIONS_KEY),
    JSON.stringify([...next]),
  );
}

export function removeSpendingLease(id: string): void {
  const lease = readAll().find((row) => row.id === id);
  if (lease !== undefined && lease.reserveAttemptId !== "") {
    try {
      getSpendingLedger().release(lease.reserveAttemptId);
    } catch {
      // Already released or missing — still drop the row.
    }
  }
  writeAll(readAll().filter((row) => row.id !== id));
}

export function clearSpendingLeases(): void {
  cacheRows([]);
  try {
    localStorage.removeItem(leaseKey());
    localStorage.removeItem(walletStorageKey(SPENT_ASSERTIONS_KEY));
    if (walletStorageTomb() === "personal") {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SPENT_ASSERTIONS_KEY);
    }
  } catch {
    // ignore
  }
}

export type IssueSpendingLeaseInput = {
  readonly allocationRef: string;
  readonly beneficiaryRef: string;
  readonly grantRef: string;
  readonly rootAccountingRef: string;
  readonly intent: LocalPaymentApprovalIntent;
  readonly proof: DigestBoundPaymentProof;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly policyVersion?: string;
};

export type IssueSpendingLeaseResult =
  | { readonly ok: true; readonly lease: LeaseRecord }
  | {
      readonly ok: false;
      readonly reason:
        | DigestBoundApprovalRefusal
        | "allocation_missing"
        | "allocation_mismatch"
        | "insufficient_available"
        | "invalid_amount"
        | "assertion_replay"
        | "lease_window_invalid"
        | "lease_expired";
    };

/**
 * Issue a lease under an existing ledger allocation after digest-bound
 * approval. Does not call external rails.
 */
function leaseIntentBinding(
  input: IssueSpendingLeaseInput,
): IssueSpendingLeaseResult | null {
  const mismatch =
    input.allocationRef !== input.intent.allocationRef ||
    (input.policyVersion !== undefined &&
      input.policyVersion !== input.intent.policyVersion);
  if (mismatch) {
    return { ok: false, reason: "allocation_mismatch" };
  }
  const windowMismatch =
    input.validFrom !== input.intent.validFrom ||
    input.validUntil !== input.intent.validUntil;
  if (windowMismatch) {
    return { ok: false, reason: "lease_window_invalid" };
  }
  return null;
}

export async function issueSpendingLease(
  input: IssueSpendingLeaseInput,
): Promise<IssueSpendingLeaseResult> {
  const bound = leaseIntentBinding(input);
  if (bound !== null) return bound;

  const node = getSpendingLedger().project(input.intent.allocationRef);
  if (node === undefined) {
    return { ok: false, reason: "allocation_missing" };
  }

  const assessment = await assessLocalPaymentApproval({
    intent: input.intent,
    proof: input.proof,
  });
  if (!assessment.ok) {
    return { ok: false, reason: assessment.reason };
  }

  const fromMs = Date.parse(input.intent.validFrom);
  const untilMs = Date.parse(input.intent.validUntil);
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(untilMs) ||
    untilMs <= fromMs ||
    untilMs <= Date.now()
  ) {
    return { ok: false, reason: "lease_window_invalid" };
  }

  if (!/^[0-9]+$/u.test(input.intent.amount)) {
    return { ok: false, reason: "invalid_amount" };
  }
  const amount = BigInt(input.intent.amount);

  const approvalDigest = await buildLocalPaymentApprovalDigest(input.intent);
  if (readSpentAssertions().has(assertionFingerprint(approvalDigest))) {
    return { ok: false, reason: "assertion_replay" };
  }
  const attemptId = `lease-res-${approvalDigest.slice(0, 12)}-${Date.now().toString(36)}`;
  try {
    getSpendingLedger().reserve({
      attemptId,
      nodeId: input.intent.allocationRef,
      amount,
    });
  } catch {
    return { ok: false, reason: "insufficient_available" };
  }

  const id = `lease-${approvalDigest.slice(0, 12)}-${Date.now().toString(36)}`;
  const lease: LeaseRecord = {
    id,
    grantRef: input.grantRef,
    allocationRef: input.intent.allocationRef,
    policyVersion: input.intent.policyVersion,
    beneficiaryRef: input.beneficiaryRef,
    proofKeyThumbprint: "local-demo",
    validFrom: input.intent.validFrom,
    validUntil: input.intent.validUntil,
    requiredEnforcementDigest: approvalDigest,
    effectiveEnforcementDigest: approvalDigest,
    rootAccountingRef: input.rootAccountingRef,
    status: "active",
    amount: input.intent.amount,
    currency: input.intent.currency,
    recipient: input.intent.recipient,
    approvalDigest,
    reserveAttemptId: attemptId,
  };

  writeAll([...readAll(), lease]);
  markAssertionSpent(assertionFingerprint(approvalDigest));
  return { ok: true, lease };
}

/** Active leases only — expired rows are marked and withheld from authority use. */
export function listActiveSpendingLeases(
  nowMs: number = Date.now(),
): readonly LeaseRecord[] {
  const all = readAll();
  const next: LeaseRecord[] = [];
  let mutated = false;
  for (const lease of all) {
    const until = Date.parse(lease.validUntil);
    if (Number.isFinite(until) && until <= nowMs) {
      if (lease.status === "active") {
        try {
          getSpendingLedger().release(lease.reserveAttemptId);
        } catch {
          // Already released or unknown attempt — still mark expired.
        }
        next.push({ ...lease, status: "expired" });
        mutated = true;
      } else {
        next.push(lease);
      }
      continue;
    }
    next.push(lease);
  }
  if (mutated) writeAll(next);
  return next.filter((l) => l.status === "active");
}

/** Mark an active lease stop_requested. Does not claim on-chain revocation. */
export function requestStopSpendingLease(leaseId: string): boolean {
  const all = readAll();
  const idx = all.findIndex((l) => l.id === leaseId);
  if (idx < 0) return false;
  const current = all[idx];
  if (current === undefined || current.status !== "active") return false;
  const next = [...all];
  next[idx] = { ...current, status: "stop_requested" };
  writeAll(next);
  return true;
}
