/**
 * Duress alert adapter surface (ALERT).
 * Maps sealed packages to channel delivery without inventing success.
 * Delivery outcomes stay honest: delivered ≠ recipient_received ≠ human ack.
 */

import type { DeliveryOutcome, DeliveryStatus } from "../contract.js";

export type DuressAlertWirePackage = Readonly<{
  packageId: string;
  incidentId: string;
  routeRef: string;
  templateRef: string;
  ciphertextB64: string;
  evidenceMacB64: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}>;

/** Secret-free diagnostics — never includes ciphertext or MAC material. */
export type DuressAlertDiagnostic = Readonly<{
  packageId: string;
  routeRef: string;
  templateRef: string;
  issuedAt: string;
  expiresAt: string;
  transportStatus?: DeliveryStatus;
  error?: string;
}>;

export function toSecretFreeDiagnostic(
  pkg: DuressAlertWirePackage,
  transport?: DeliveryOutcome,
): DuressAlertDiagnostic {
  const base: DuressAlertDiagnostic = {
    packageId: pkg.packageId,
    routeRef: pkg.routeRef,
    templateRef: pkg.templateRef,
    issuedAt: pkg.issuedAt,
    expiresAt: pkg.expiresAt,
  };
  if (transport?.status !== undefined) {
    return transport.error !== undefined
      ? { ...base, transportStatus: transport.status, error: transport.error }
      : { ...base, transportStatus: transport.status };
  }
  if (transport?.error !== undefined) {
    return { ...base, error: transport.error };
  }
  return base;
}

/**
 * Map channel DeliveryStatus into outbox relay acceptance.
 * Never promote transport "delivered" to human acknowledgement.
 */
export function mapTransportToRelayAccept(
  outcome: DeliveryOutcome,
): "accepted" | "rejected" | "retryable" {
  switch (outcome.status) {
    case "delivered":
      return "accepted";
    case "retryable":
      return "retryable";
    case "permanent":
    case "unconfigured":
      return "rejected";
  }
}

export type LocalDeliveryDoubleMode =
  | "accept"
  | "reject"
  | "retryable"
  | "throw";

export type LocalDeliveryDouble = Readonly<{
  attempts: DuressAlertWirePackage[];
  deliver(pkg: DuressAlertWirePackage): Promise<DeliveryOutcome>;
}>;

/**
 * Local delivery double for tests — records attempts; never stubs success
 * unless the caller explicitly configures accept.
 */
export function createLocalDeliveryDouble(opts?: {
  mode?: LocalDeliveryDoubleMode;
}): LocalDeliveryDouble {
  const attempts: DuressAlertWirePackage[] = [];
  const mode = opts?.mode ?? "accept";
  return {
    attempts,
    async deliver(pkg) {
      attempts.push(pkg);
      switch (mode) {
        case "accept":
          return {
            status: "delivered",
            providerMessageRef: `local-${pkg.packageId}`,
          };
        case "reject":
          return { status: "permanent", error: "relay_rejected" };
        case "retryable":
          return { status: "retryable", error: "transient" };
        case "throw":
          throw new Error("network");
      }
    },
  };
}

export type ClearedLocalDeliveryQueue = Readonly<{
  cleared: number;
  remoteRetracted: false;
}>;

/**
 * Queue-deletion / wipe of local pending delivery state for a double.
 * Does not claim remote retraction.
 */
export function clearLocalDeliveryQueue(
  double: Pick<LocalDeliveryDouble, "attempts">,
): ClearedLocalDeliveryQueue {
  const cleared = double.attempts.length;
  double.attempts.length = 0;
  return { cleared, remoteRetracted: false };
}
