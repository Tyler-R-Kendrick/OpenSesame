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
      "ACCOUNTING_AUTHORITY_UNAVAILABLE: remaining allocation is required before prepare",
    );
    this.name = "X402AccountingUnavailableError";
  }
}

export class X402InsufficientAvailableError extends Error {
  readonly code = "INSUFFICIENT_AVAILABLE" as const;
  constructor() {
    super(
      "INSUFFICIENT_AVAILABLE: payment amount exceeds remaining allocation",
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

function assertWithinRemaining(
  amount: string,
  remainingAllocation: string,
): void {
  if (
    parseAllocationUnits(amount) > parseAllocationUnits(remainingAllocation)
  ) {
    throw new X402InsufficientAvailableError();
  }
}

export function describeX402Adapter(
  input: { readonly localExecutionVerified?: boolean } = {},
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

type PreparedSlot = {
  readonly prepared: PreparedExactPayment;
  readonly remainingAllocation: string;
};

const preparedSlots = new Map<string, PreparedSlot>();

export async function prepareX402Payment(input?: {
  readonly runtime: LocalExactRuntime;
  readonly remainingAllocation: string;
}): Promise<{ ref: string; expiresAt: string }> {
  if (input === undefined) throw new X402AdapterBlockedError("prepare");
  if (isMainnetChainId(input.runtime.chainId))
    throw new Error("MAINNET_DENIED");
  if (input.remainingAllocation === undefined) {
    throw new X402AccountingUnavailableError();
  }
  assertWithinRemaining(input.runtime.amount, input.remainingAllocation);
  const prepared = await createExactPaymentPayload(input.runtime);
  const ref = `prepared:x402:${globalThis.crypto.randomUUID()}`;
  preparedSlots.set(ref, {
    prepared,
    remainingAllocation: input.remainingAllocation,
  });
  return { ref, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

export async function executeX402Payment(input?: {
  readonly preparedRef: string;
}): Promise<{
  status: "confirmed" | "failed";
  detail: string;
  transaction?: string;
}> {
  if (input === undefined) throw new X402AdapterBlockedError("execute");
  const slot = preparedSlots.get(input.preparedRef);
  if (slot === undefined) {
    return {
      status: "failed",
      detail: "PreparedExecutionRef missing or already used",
    };
  }
  try {
    assertWithinRemaining(
      slot.prepared.runtime.amount,
      slot.remainingAllocation,
    );
  } catch (error) {
    if (error instanceof X402InsufficientAvailableError) {
      return { status: "failed", detail: error.code };
    }
    throw error;
  }
  preparedSlots.delete(input.preparedRef);
  const settled = await settleExactPayment(slot.prepared);
  if (!settled.success) {
    return settled.transaction === undefined
      ? {
          status: "failed",
          detail: settled.errorReason ?? "settle_failed",
        }
      : {
          status: "failed",
          detail: settled.errorReason ?? "settle_failed",
          transaction: settled.transaction,
        };
  }
  if (settled.transaction === undefined) {
    return { status: "failed", detail: "settle_missing_transaction" };
  }
  return {
    status: "confirmed",
    detail: "exact eip3009 settled on local chain",
    transaction: settled.transaction,
  };
}

export async function reconcileX402Payment(input?: {
  readonly preparedRef: string;
}): Promise<{ status: "matched" | "unknown"; detail: string }> {
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
