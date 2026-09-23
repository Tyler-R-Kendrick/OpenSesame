/**
 * x402 adapter: prepare/execute need an explicit Anvil runtime.
 * Pages never pass that runtime. productionEnabled stays false.
 */

import { x402Version } from "@x402/core";
import { assessExactPayment } from "./assess.js";
import { isMainnetChainId } from "./chain-guard.js";
import {
  type LocalExactRuntime,
  type PreparedExactPayment,
  assertLocalExactRuntime,
  createExactPaymentPayload,
  settleExactPayment,
  verifyExactPaymentMismatch,
} from "./exact-settle.js";
import type {
  AssessExactPaymentInput,
  ExactPaymentAssessment,
  X402AdapterManifest,
} from "./types.js";

export const X402_ADAPTER_BLOCKED_REASON =
  "runtime prepare/execute blocked without a local Anvil Exact runtime; Pages/production never activate settlement";

export const X402_SDK_PINS = {
  core: "@x402/core@2.26.0",
  evm: "@x402/evm@2.26.0",
  protocolVersion: x402Version,
} as const;

export class X402AdapterBlockedError extends Error {
  readonly code = "X402_ADAPTER_BLOCKED" as const;
  constructor(operation: "prepare" | "execute" | "reconcile") {
    super(`${X402_ADAPTER_BLOCKED_REASON} (refused ${operation})`);
    this.name = "X402AdapterBlockedError";
  }
}

export class X402AccountingUnavailableError extends Error {
  readonly code = "ACCOUNTING_AUTHORITY_UNAVAILABLE" as const;
  constructor() {
    super(
      "ACCOUNTING_AUTHORITY_UNAVAILABLE: an allocation reservation is required before prepare",
    );
    this.name = "X402AccountingUnavailableError";
  }
}

export class X402InsufficientAvailableError extends Error {
  readonly code = "INSUFFICIENT_AVAILABLE" as const;
  constructor() {
    super(
      "INSUFFICIENT_AVAILABLE: payment amount exceeds the reserved allocation",
    );
    this.name = "X402InsufficientAvailableError";
  }
}

function parseAllocationUnits(value: string): bigint {
  if (!/^[0-9]+$/u.test(value)) {
    throw new X402InsufficientAvailableError();
  }
  return BigInt(value);
}

function assertWithinReservation(
  amount: string,
  reservation: X402AllocationReservation,
): void {
  if (
    parseAllocationUnits(amount) >
    parseAllocationUnits(reservation.reservedAmount)
  ) {
    throw new X402InsufficientAvailableError();
  }
}

export function describeX402Adapter(
  input: DescribeX402AdapterInput = {},
): X402AdapterManifest {
  return {
    adapterId: "x402-exact",
    packageName: "@opensesame/wallet-x402",
    protocol: "x402",
    supportedSchemes: ["exact"],
    evidenceStatus: input.localExecutionVerified
      ? "local_execution_verified"
      : "blocked",
    productionEnabled: false,
    blockedReason: input.localExecutionVerified
      ? "productionEnabled remains false; local Anvil only"
      : X402_ADAPTER_BLOCKED_REASON,
    sdkPins: X402_SDK_PINS,
    headers: {
      paymentRequired: "PAYMENT-REQUIRED",
      paymentSignature: "PAYMENT-SIGNATURE",
      paymentResponse: "PAYMENT-RESPONSE",
    },
  };
}

export function assessX402Adapter(
  input: AssessExactPaymentInput,
): ExactPaymentAssessment {
  return assessExactPayment(input);
}

/**
 * A hold the caller's accounting authority has already placed for this one
 * payment — for example an `@opensesame/wallet-budget` `reserve` of an
 * attempt id, wrapped so `commit`/`release` settle that attempt. This package
 * does not depend on a ledger, so it takes the hold as a handle instead of a
 * remaining-balance string: a string is a snapshot two prepares can both
 * spend, a reservation is not.
 *
 * Ownership: the caller keeps the hold until `prepareX402Payment` returns a
 * ref (and must release it itself if prepare throws). From then on the
 * adapter settles it exactly once — `commit` after a confirmed settlement,
 * `release` when the ref expires or settlement reports failure. If settlement
 * throws, the outcome is unknown and the hold is left in place for
 * reconciliation rather than released.
 */
export interface X402AllocationReservation {
  /** Units held for this payment (decimal string). */
  readonly reservedAmount: string;
  commit(): void | Promise<void>;
  release(): void | Promise<void>;
}

/** Settlement outcome as the exact scheme reports it. */
export type X402SettlementOutcome = {
  readonly success: boolean;
  readonly transaction?: string | undefined;
  readonly errorReason?: string | undefined;
};

/**
 * Where a prepared payment is built and settled. Chosen at prepare time and
 * pinned to the ref, so whoever executes cannot swap it. Defaults to the
 * local Anvil exact scheme; the local-runtime guard runs either way.
 */
export type X402SettlementPort = {
  readonly createPayload: (
    runtime: LocalExactRuntime,
  ) => Promise<PreparedExactPayment>;
  readonly settle: (
    prepared: PreparedExactPayment,
  ) => Promise<X402SettlementOutcome>;
};

const LOCAL_EXACT_SETTLEMENT: X402SettlementPort = {
  createPayload: createExactPaymentPayload,
  settle: settleExactPayment,
};

type PreparedSlot = {
  readonly prepared: PreparedExactPayment;
  readonly reservation: X402AllocationReservation;
  readonly settlement: X402SettlementPort;
  readonly expiresAtMs: number;
  timer?: ReturnType<typeof setTimeout>;
};

/** How long a prepared payment may wait for execution. */
export const X402_PREPARED_TTL_MS = 60_000;

/**
 * Most prepared payments that may wait at once. Each one pins a caller's
 * reservation, so an unbounded table is both a memory leak and a way to strand
 * allocation; past this, prepare refuses before it takes ownership of a hold.
 */
export const X402_MAX_PREPARED_SLOTS = 1_024;

export class X402PreparedCapacityError extends Error {
  readonly code = "PREPARED_CAPACITY_EXCEEDED" as const;
  constructor() {
    super(
      "PREPARED_CAPACITY_EXCEEDED: too many prepared x402 payments are awaiting execution",
    );
    this.name = "X402PreparedCapacityError";
  }
}

type DescribeX402AdapterInput = {
  readonly localExecutionVerified?: boolean;
};

export type PreparedX402PaymentRef = {
  readonly ref: string;
  readonly expiresAt: string;
};

export type ExecutedX402Payment = {
  readonly status: "confirmed" | "failed";
  readonly detail: string;
  readonly transaction?: string;
};

export type ReconciledX402Payment = {
  readonly status: "matched" | "unknown";
  readonly detail: string;
};

type PrepareX402PaymentInput = {
  readonly runtime: LocalExactRuntime;
  readonly reservation: X402AllocationReservation;
  readonly settlement?: X402SettlementPort;
};

type ExecuteX402PaymentInput = {
  readonly preparedRef: string;
};

type ReconcileX402PaymentInput = {
  readonly preparedRef: string;
};

const preparedSlots = new Map<string, PreparedSlot>();

/**
 * Remove a slot from the table and hand it to the one caller that removed it.
 * Every path that settles a hold — execute, the expiry timer, the sweep — goes
 * through here with no await between the check and the delete, so exactly one
 * of them ever owns the slot's `commit`/`release`.
 */
function takeSlot(ref: string): PreparedSlot | undefined {
  const slot = preparedSlots.get(ref);
  if (slot === undefined) return undefined;
  preparedSlots.delete(ref);
  if (slot.timer !== undefined) clearTimeout(slot.timer);
  return slot;
}

function releaseExpired(ref: string): void {
  const slot = takeSlot(ref);
  if (slot === undefined) return;
  // Nobody awaits a sweep; a failing release is the caller's accounting
  // authority's to report, and must not fail an unrelated prepare.
  Promise.resolve()
    .then(() => slot.reservation.release())
    .catch(() => undefined);
}

/** Release every prepared ref whose `expiresAt` has passed and was never run. */
export function sweepExpiredX402Payments(nowMs: number = Date.now()): number {
  let swept = 0;
  for (const [ref, slot] of [...preparedSlots]) {
    if (nowMs < slot.expiresAtMs) continue;
    releaseExpired(ref);
    swept += 1;
  }
  return swept;
}

function assertPreparedCapacity(): void {
  if (preparedSlots.size >= X402_MAX_PREPARED_SLOTS) {
    throw new X402PreparedCapacityError();
  }
}

export async function prepareX402Payment(
  input?: PrepareX402PaymentInput,
): Promise<PreparedX402PaymentRef> {
  if (input === undefined) throw new X402AdapterBlockedError("prepare");
  if (isMainnetChainId(input.runtime.chainId))
    throw new Error("MAINNET_DENIED");
  assertLocalExactRuntime(input.runtime);
  if (input.reservation === undefined) {
    throw new X402AccountingUnavailableError();
  }
  assertWithinReservation(input.runtime.amount, input.reservation);
  sweepExpiredX402Payments();
  assertPreparedCapacity();
  const settlement = input.settlement ?? LOCAL_EXACT_SETTLEMENT;
  const prepared = await settlement.createPayload(input.runtime);
  // Concurrent prepares may all have passed the first check while awaiting
  // the payload; the hold is still the caller's until this returns a ref.
  assertPreparedCapacity();
  const ref = `prepared:x402:${globalThis.crypto.randomUUID()}`;
  const expiresAtMs = Date.now() + X402_PREPARED_TTL_MS;
  const slot: PreparedSlot = {
    prepared,
    reservation: input.reservation,
    settlement,
    expiresAtMs,
  };
  preparedSlots.set(ref, slot);
  // A ref nobody executes still gives its hold back at expiresAt. Unref'd so
  // a waiting payment never keeps a process alive on its own.
  slot.timer = setTimeout(() => releaseExpired(ref), X402_PREPARED_TTL_MS);
  slot.timer.unref?.();
  return { ref, expiresAt: new Date(expiresAtMs).toISOString() };
}

function failedSettlement(settled: X402SettlementOutcome): ExecutedX402Payment {
  const detail = settled.errorReason ?? "settle_failed";
  return settled.transaction === undefined
    ? { status: "failed", detail }
    : { status: "failed", detail, transaction: settled.transaction };
}

export async function executeX402Payment(
  input?: ExecuteX402PaymentInput,
): Promise<ExecutedX402Payment> {
  if (input === undefined) throw new X402AdapterBlockedError("execute");
  // Single-use from here on, before any await, so a concurrent execute of the
  // same ref (or the expiry sweep) finds nothing.
  const slot = takeSlot(input.preparedRef);
  sweepExpiredX402Payments();
  if (slot === undefined) {
    return {
      status: "failed",
      detail: "PreparedExecutionRef missing or already used",
    };
  }
  if (Date.now() >= slot.expiresAtMs) {
    await slot.reservation.release();
    return { status: "failed", detail: "PREPARED_REF_EXPIRED" };
  }
  const settled = await slot.settlement.settle(slot.prepared);
  if (!settled.success) {
    await slot.reservation.release();
    return failedSettlement(settled);
  }
  // A success with no transaction hash still moved funds as far as the
  // facilitator is concerned; keep the hold for reconciliation.
  if (settled.transaction === undefined) {
    return { status: "failed", detail: "settle_missing_transaction" };
  }
  await slot.reservation.commit();
  return {
    status: "confirmed",
    detail: "exact eip3009 settled on local chain",
    transaction: settled.transaction,
  };
}

export async function reconcileX402Payment(
  input?: ReconcileX402PaymentInput,
): Promise<ReconciledX402Payment> {
  if (input === undefined) throw new X402AdapterBlockedError("reconcile");
  return {
    status: "unknown",
    detail: "reconcile requires chain observation; slot is single-use",
  };
}

export async function refuseMutatedExactAmount(
  preparedRef: string,
  mutatedAmount: string,
): Promise<boolean> {
  const slot = preparedSlots.get(preparedRef);
  if (slot === undefined) return false;
  return verifyExactPaymentMismatch(slot.prepared, mutatedAmount);
}

export type { LocalExactRuntime } from "./exact-settle.js";
