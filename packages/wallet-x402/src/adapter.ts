/**
 * x402 payment adapter boundary.
 *
 * Discovery and pure assessment are available; prepare/execute stay blocked
 * until a local merchant/facilitator harness produces evidence under
 * `docs/evidence/wallet/`. No mainnet and no real facilitator accounts.
 */

import { x402Version } from "@x402/core";
import { assessExactPayment } from "./assess.js";
import type {
  AssessExactPaymentInput,
  ExactPaymentAssessment,
  X402AdapterManifest,
} from "./types.js";

export const X402_ADAPTER_BLOCKED_REASON =
  "runtime prepare/execute blocked: Exact EIP-3009 settlement is proven only under pnpm wallet:test:protocols (Anvil); Pages/runtime never activates production settlement";

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

/** Manifest: settlement remains runtime-blocked; harness evidence is separate. */
export function describeX402Adapter(): X402AdapterManifest {
  return {
    adapterId: "x402-exact",
    packageName: "@opensesame/wallet-x402",
    protocol: "x402",
    supportedSchemes: ["exact"],
    // Runtime activation stays blocked; Anvil harness may still claim
    // local_execution_verified in docs/evidence/wallet/claims.json.
    evidenceStatus: "blocked",
    productionEnabled: false,
    blockedReason: X402_ADAPTER_BLOCKED_REASON,
    sdkPins: X402_SDK_PINS,
    headers: {
      paymentRequired: "PAYMENT-REQUIRED",
      paymentSignature: "PAYMENT-SIGNATURE",
      paymentResponse: "PAYMENT-RESPONSE",
    },
  };
}

/**
 * Adapter assess delegates to the pure exact-payment assessor.
 * Does not claim local_execution_verified.
 */
export function assessX402Adapter(
  input: AssessExactPaymentInput,
): ExactPaymentAssessment {
  return assessExactPayment(input);
}

/** Blocked until harness exists. */
export function prepareX402Payment(): never {
  throw new X402AdapterBlockedError("prepare");
}

/** Blocked until harness exists. */
export function executeX402Payment(): never {
  throw new X402AdapterBlockedError("execute");
}

/** Blocked until harness exists. */
export function reconcileX402Payment(): never {
  throw new X402AdapterBlockedError("reconcile");
}
