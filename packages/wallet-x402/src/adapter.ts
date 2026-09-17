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

const preparedSlots = new Map<string, PreparedExactPayment>();
let prepareSeq = 0;

export async function prepareX402Payment(input?: {
  readonly runtime: LocalExactRuntime;
}): Promise<{ ref: string; expiresAt: string }> {
  if (input === undefined) throw new X402AdapterBlockedError("prepare");
  if (isMainnetChainId(input.runtime.chainId)) throw new Error("MAINNET_DENIED");
  prepareSeq += 1;
  const prepared = await createExactPaymentPayload(input.runtime);
  const ref = `prepared:x402:${prepareSeq}`;
  preparedSlots.set(ref, prepared);
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
    return { status: "failed", detail: "PreparedExecutionRef missing or already used" };
  }
  preparedSlots.delete(input.preparedRef);
  const settled = await settleExactPayment(slot);
  if (!settled.success) {
    return {
      status: "failed",
      detail: settled.errorReason ?? "settle_failed",
      transaction: settled.transaction,
    };
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
  return verifyExactPaymentMismatch(slot, mutatedAmount);
}

export type { LocalExactRuntime } from "./exact-settle.js";
