import {
  type PaymentInitiationDetail,
  assertNoPaymentCredentials,
} from "../authorization-details.js";
import type { JsonObject, JsonValue } from "../json.js";
import {
  isJsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "../json.js";
import { type AmountUnits, assertAmountUnits } from "./amount.js";
import { walletError } from "./errors.js";
import type {
  AssetRef,
  PaymentLifecycle,
  RequiredEnforcement,
  WalletDigest,
  WalletRef,
} from "./types.js";

export const EXECUTABLE_PAYMENT_INTENT_TYPE =
  "executable_payment_intent" as const;
export const EXECUTABLE_PAYMENT_INTENT_VERSION = 1 as const;

/**
 * Destination identity for execution. A merchant display name alone is never
 * enough — bind an account, address, connection, or escrow channel.
 */
export type PaymentDestination =
  | {
      readonly kind: "account";
      readonly accountRef: WalletRef;
      readonly chainId?: string;
      readonly displayName?: string;
    }
  | {
      readonly kind: "address";
      readonly chainId: string;
      readonly address: string;
      readonly displayName?: string;
    }
  | {
      readonly kind: "connection";
      readonly connectionRef: WalletRef;
      readonly displayName?: string;
    }
  | {
      readonly kind: "escrow";
      readonly channelRef: WalletRef;
      readonly displayName?: string;
    };

export type CriticalExtensionHandling = "refuse" | "preserve_bytes";

/**
 * Versioned executable payment intent.
 *
 * Lives alongside `payment_initiation` (authorization-only display/approve
 * shape). This record is what a broker may reserve and submit against.
 */
export type ExecutablePaymentIntent = {
  readonly type: typeof EXECUTABLE_PAYMENT_INTENT_TYPE;
  readonly version: typeof EXECUTABLE_PAYMENT_INTENT_VERSION;
  readonly id: WalletRef;
  readonly walletRef: WalletRef;
  readonly domainRef: WalletRef;
  readonly leaseRef: WalletRef;
  readonly allocationRef: WalletRef;
  readonly destination: PaymentDestination;
  readonly asset: AssetRef;
  readonly amount: AmountUnits;
  readonly feeCeiling: AmountUnits;
  readonly policyVersion: string;
  readonly idempotencyScope: string;
  readonly requiredEnforcement: RequiredEnforcement;
  readonly requesterPrincipalRef: WalletRef;
  readonly proofKeyThumbprint: string;
  readonly protocolProfileRef: WalletRef;
  readonly requestCommitment: WalletDigest;
  readonly executionEnvironmentRef: WalletRef;
  readonly rootAccountingRef: WalletRef;
  readonly validFrom: string;
  readonly validUntil: string;
  /** Optional authorization companion — never a substitute for destination. */
  readonly authorizationDetail?: PaymentInitiationDetail;
  /** Unrecognized critical extensions must fail closed (DOM-07). */
  readonly criticalExtensions?: JsonObject[];
  readonly criticalExtensionHandling?: CriticalExtensionHandling;
};

const REF_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9+/=_-]{16,256}$/;

function requireRef(value: string, label: string): WalletRef {
  if (!REF_PATTERN.test(value)) {
    throw walletError("INTENT_INVALID", `${label} is not a valid opaque ref`);
  }
  return value;
}

function requireDigest(value: string, label: string): WalletDigest {
  if (!DIGEST_PATTERN.test(value)) {
    throw walletError("INTENT_INVALID", `${label} is not a valid digest`);
  }
  return value;
}

function assertAssetRef(asset: AssetRef): void {
  if (asset.kind === "fiat") {
    if (!/^[A-Z]{3}$/.test(asset.currency)) {
      throw walletError(
        "INTENT_INVALID",
        "fiat currency must be ISO 4217 uppercase",
      );
    }
    if (
      !Number.isInteger(asset.exponent) ||
      asset.exponent < 0 ||
      asset.exponent > 18
    ) {
      throw walletError("INTENT_INVALID", "fiat exponent out of range");
    }
    return;
  }
  requireRef(asset.chainId, "asset.chainId");
  requireRef(asset.contract, "asset.contract");
  if (
    !Number.isInteger(asset.decimals) ||
    asset.decimals < 0 ||
    asset.decimals > 18
  ) {
    throw walletError("INTENT_INVALID", "token decimals out of range");
  }
  requireDigest(asset.deploymentFingerprint, "asset.deploymentFingerprint");
}

function assertDestination(destination: PaymentDestination): void {
  switch (destination.kind) {
    case "account":
      requireRef(destination.accountRef, "destination.accountRef");
      return;
    case "address":
      requireRef(destination.chainId, "destination.chainId");
      if (!/^[A-Za-z0-9:xX]{4,128}$/.test(destination.address)) {
        throw walletError(
          "DESTINATION_IDENTITY_REQUIRED",
          "destination.address is malformed",
        );
      }
      return;
    case "connection":
      requireRef(destination.connectionRef, "destination.connectionRef");
      return;
    case "escrow":
      requireRef(destination.channelRef, "destination.channelRef");
      return;
    default: {
      /* SAFETY: PaymentDestination is a closed union; narrowing exhausted. */
      const _exhaustive: never = destination;
      void _exhaustive;
      throw walletError(
        "DESTINATION_IDENTITY_REQUIRED",
        "destination kind is unsupported",
      );
    }
  }
}

export function isExecutablePaymentIntent(
  value: JsonValue,
): value is ExecutablePaymentIntent {
  if (!isJsonObject(value)) return false;
  return (
    value.type === EXECUTABLE_PAYMENT_INTENT_TYPE &&
    value.version === EXECUTABLE_PAYMENT_INTENT_VERSION
  );
}

/**
 * Validate an executable intent. Runs the payment-credential refuse list over
 * the whole payload so PAN/CVV/seed-shaped fields cannot ride along.
 */
export function assertExecutablePaymentIntent(
  value: JsonValue,
): asserts value is ExecutablePaymentIntent {
  assertNoPaymentCredentials(value);
  if (!isJsonObject(value)) {
    throw walletError(
      "INTENT_INVALID",
      "executable payment intent must be an object",
    );
  }
  if (value.type !== EXECUTABLE_PAYMENT_INTENT_TYPE) {
    throw walletError(
      "INTENT_INVALID",
      `expected type ${EXECUTABLE_PAYMENT_INTENT_TYPE}`,
    );
  }
  if (value.version !== EXECUTABLE_PAYMENT_INTENT_VERSION) {
    throw walletError(
      "INTENT_INVALID",
      "unsupported executable payment intent version",
    );
  }

  /*
   * SAFETY: type/version/refs/amounts/destination checked above and below;
   * JsonObject shape overlaps ExecutablePaymentIntent at this boundary.
   */
  const intent: ExecutablePaymentIntent = overlapCast(value);

  requireRef(intent.id, "id");
  requireRef(intent.walletRef, "walletRef");
  requireRef(intent.domainRef, "domainRef");
  requireRef(intent.leaseRef, "leaseRef");
  requireRef(intent.allocationRef, "allocationRef");
  requireRef(intent.requesterPrincipalRef, "requesterPrincipalRef");
  requireRef(intent.protocolProfileRef, "protocolProfileRef");
  requireRef(intent.executionEnvironmentRef, "executionEnvironmentRef");
  requireRef(intent.rootAccountingRef, "rootAccountingRef");
  requireDigest(intent.requestCommitment, "requestCommitment");

  if (!isString(intent.policyVersion) || intent.policyVersion.length === 0) {
    throw walletError("POLICY_VERSION_CONFLICT", "policyVersion is required");
  }
  if (
    !isString(intent.idempotencyScope) ||
    intent.idempotencyScope.length === 0
  ) {
    throw walletError(
      "IDEMPOTENCY_SCOPE_REQUIRED",
      "idempotencyScope is required",
    );
  }
  if (
    intent.requiredEnforcement !== "local_approval" &&
    intent.requiredEnforcement !== "independent_execution"
  ) {
    throw walletError(
      "REQUIRED_CONSTRAINT_UNSUPPORTED",
      "requiredEnforcement is invalid",
    );
  }
  if (
    !isString(intent.proofKeyThumbprint) ||
    intent.proofKeyThumbprint.length < 8
  ) {
    throw walletError(
      "PROOF_BINDING_INVALID",
      "proofKeyThumbprint is required",
    );
  }
  if (!isString(intent.validFrom) || !isString(intent.validUntil)) {
    throw walletError("INTENT_INVALID", "validity window is required");
  }
  if (intent.validUntil <= intent.validFrom) {
    throw walletError("INTENT_INVALID", "validUntil must be after validFrom");
  }

  if (!isTypeofObject(intent.destination) || intent.destination === null) {
    throw walletError(
      "DESTINATION_IDENTITY_REQUIRED",
      "destination identity is required",
    );
  }
  assertDestination(intent.destination);
  if (!isTypeofObject(intent.asset) || intent.asset === null) {
    throw walletError("INTENT_INVALID", "asset is required");
  }
  assertAssetRef(intent.asset);
  assertAmountUnits(intent.amount);
  assertAmountUnits(intent.feeCeiling);

  if (intent.criticalExtensions !== undefined) {
    if (!Array.isArray(intent.criticalExtensions)) {
      throw walletError(
        "CRITICAL_EXTENSION_UNSUPPORTED",
        "criticalExtensions must be an array",
      );
    }
    const handling = intent.criticalExtensionHandling ?? "refuse";
    if (handling === "refuse" && intent.criticalExtensions.length > 0) {
      throw walletError(
        "CRITICAL_EXTENSION_UNSUPPORTED",
        "unrecognized critical extensions are refused",
      );
    }
  }
}

const LOCAL_INTENT_TRANSITIONS = {
  proposed: ["approved", "rejected", "cancelled"],
  approved: ["cancelled"],
  rejected: [],
  cancelled: [],
} as const;

const EXECUTION_TRANSITIONS = {
  not_started: ["reserved"],
  reserved: ["authorized", "unknown"],
  authorized: ["submitted", "unknown"],
  submitted: ["unknown"],
  unknown: [],
} as const;

const SETTLEMENT_TRANSITIONS = {
  none: ["pending"],
  pending: ["settled", "definitively_failed", "reorganized"],
  settled: ["reorganized"],
  definitively_failed: [],
  reorganized: ["pending", "settled", "definitively_failed"],
} as const;

const RECOVERY_TRANSITIONS = {
  none: ["claim_pending", "refund_pending", "disputed"],
  claim_pending: ["recovered", "disputed"],
  refund_pending: ["recovered", "disputed"],
  recovered: [],
  disputed: ["recovered"],
} as const;

const AUTHORITY_RANK = {
  active: 0,
  stop_requested: 1,
  revocation_pending: 2,
  revoked: 3,
  expired: 3,
} as const;

function assertAllowedTransition(
  dimension: string,
  from: string,
  to: string,
  allowedFrom: readonly string[],
): void {
  if (!allowedFrom.includes(to)) {
    throw walletError(
      "LIFECYCLE_TRANSITION_INVALID",
      `invalid ${dimension} transition: ${from} -> ${to}`,
      { details: { dimension, from, to } },
    );
  }
}

/** DOM-05: validate a single lifecycle dimension transition. */
export function assertLifecycleTransition(
  current: PaymentLifecycle,
  next: PaymentLifecycle,
): void {
  if (current.localIntent !== next.localIntent) {
    assertAllowedTransition(
      "localIntent",
      current.localIntent,
      next.localIntent,
      LOCAL_INTENT_TRANSITIONS[current.localIntent],
    );
  }
  if (current.execution !== next.execution) {
    assertAllowedTransition(
      "execution",
      current.execution,
      next.execution,
      EXECUTION_TRANSITIONS[current.execution],
    );
  }
  if (current.settlement !== next.settlement) {
    assertAllowedTransition(
      "settlement",
      current.settlement,
      next.settlement,
      SETTLEMENT_TRANSITIONS[current.settlement],
    );
  }
  if (current.recovery !== next.recovery) {
    assertAllowedTransition(
      "recovery",
      current.recovery,
      next.recovery,
      RECOVERY_TRANSITIONS[current.recovery],
    );
  }
  if (current.authority !== next.authority) {
    if (AUTHORITY_RANK[next.authority] < AUTHORITY_RANK[current.authority]) {
      throw walletError(
        "LIFECYCLE_TRANSITION_INVALID",
        `invalid authority transition: ${current.authority} -> ${next.authority}`,
      );
    }
  }
}

export function initialPaymentLifecycle(): PaymentLifecycle {
  return {
    localIntent: "proposed",
    execution: "not_started",
    settlement: "none",
    authority: "active",
    recovery: "none",
  };
}

/**
 * Old `payment_initiation` approvals stay authorization-only. They must not
 * silently become executable payment authority (DOM-08).
 */
export function paymentInitiationGrantsExecutableAuthority(
  detail: PaymentInitiationDetail,
): boolean {
  void detail;
  return false;
}
