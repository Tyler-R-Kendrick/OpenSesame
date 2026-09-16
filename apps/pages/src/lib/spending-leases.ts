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
  type DigestBoundPaymentProof,
  type LocalPaymentApprovalIntent,
  assessLocalPaymentApproval,
  buildLocalPaymentApprovalDigest,
} from "./spending-consent.js";
import { getSpendingLedger } from "./spending-ledger.js";

const STORAGE_KEY = "opensesame.wallet.leases.v1";

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
  const strings: Record<(typeof LEASE_STRING_FIELDS)[number], string> = {
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
  };
  for (const key of LEASE_STRING_FIELDS) {
    const field = value[key];
    if (!isString(field)) return undefined;
    strings[key] = field;
  }
  return { ...strings, status };
}

function readAll(): LeaseRecord[] {
  if (cache !== null) return cache;
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text === null || text === "") {
      cache = [];
      return cache;
    }
    const parsed: BoundaryValue = overlapCast(JSON.parse(text));
    if (!Array.isArray(parsed)) {
      cache = [];
      return cache;
    }
    const rows: LeaseRecord[] = [];
    for (const entry of parsed) {
      const row = parseLease(entry);
      if (row !== undefined) rows.push(row);
    }
    cache = rows;
    return rows;
  } catch {
    cache = [];
    return cache;
  }
}

function writeAll(rows: readonly LeaseRecord[]): void {
  cache = [...rows];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Keep memory copy if storage is unavailable.
  }
}

export function listSpendingLeases(): readonly LeaseRecord[] {
  return readAll();
}

const SPENT_ASSERTIONS_KEY = "opensesame.wallet.spent-assertions.v1";

function assertionFingerprint(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function readSpentAssertions(): Set<string> {
  try {
    const raw = localStorage.getItem(SPENT_ASSERTIONS_KEY);
    if (raw === null || raw === "") return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function markAssertionSpent(fp: string): void {
  const next = readSpentAssertions();
  next.add(fp);
  localStorage.setItem(SPENT_ASSERTIONS_KEY, JSON.stringify([...next]));
}

export function clearSpendingLeases(): void {
  cache = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SPENT_ASSERTIONS_KEY);
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
        | "allocation_missing"
        | "digest_mismatch"
        | "unverified_assurance"
        | "missing_verified_bytes"
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
export async function issueSpendingLease(
  input: IssueSpendingLeaseInput,
): Promise<IssueSpendingLeaseResult> {
  const node = getSpendingLedger().project(input.allocationRef);
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

  const fromMs = Date.parse(input.validFrom);
  const untilMs = Date.parse(input.validUntil);
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(untilMs) ||
    untilMs <= fromMs ||
    untilMs <= Date.now()
  ) {
    return { ok: false, reason: "lease_window_invalid" };
  }

  const verified = input.proof.verifiedBytes;
  if (verified !== undefined && verified.byteLength > 0) {
    const fp = assertionFingerprint(verified);
    if (readSpentAssertions().has(fp)) {
      return { ok: false, reason: "assertion_replay" };
    }
  }

  if (!/^[0-9]+$/u.test(input.intent.amount)) {
    return { ok: false, reason: "invalid_amount" };
  }
  const amount = BigInt(input.intent.amount);

  const approvalDigest = await buildLocalPaymentApprovalDigest(input.intent);
  const attemptId = `lease-res-${approvalDigest.slice(0, 12)}-${Date.now().toString(36)}`;
  try {
    getSpendingLedger().reserve({
      attemptId,
      nodeId: input.allocationRef,
      amount,
    });
  } catch {
    return { ok: false, reason: "insufficient_available" };
  }

  const id = `lease-${approvalDigest.slice(0, 12)}-${Date.now().toString(36)}`;
  const lease: LeaseRecord = {
    id,
    grantRef: input.grantRef,
    allocationRef: input.allocationRef,
    policyVersion: input.policyVersion ?? "1",
    beneficiaryRef: input.beneficiaryRef,
    proofKeyThumbprint: "local-demo",
    validFrom: input.validFrom,
    validUntil: input.validUntil,
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
  if (verified !== undefined && verified.byteLength > 0) {
    markAssertionSpent(assertionFingerprint(verified));
  }
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
