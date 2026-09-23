/**
 * ALERT-C: Authenticated evidence for each outbox status transition.
 * Evidence never claims emergency response or unlock authority (INV-14, INV-16).
 */

import { bytesToB64, utf8 } from "./bytes.js";
import type { AlertDeliveryStatus } from "./status.js";

export type AlertEvidenceAuthority =
  | "local_outbox"
  | "relay"
  | "recipient_device"
  | "human";

export type AlertStatusEvidence = Readonly<{
  version: 1;
  packageId: string;
  incidentId: string;
  fromStatus: AlertDeliveryStatus | "none";
  toStatus: AlertDeliveryStatus;
  authority: AlertEvidenceAuthority;
  recordedAt: string;
  /** Opaque MAC over binding fields — not a provider response body. */
  macB64: string;
  /**
   * Explicit non-guarantee. Callers must surface this; never strip it.
   * INV: alert delivery is not an emergency-response SLA.
   */
  disclaimer: "no_emergency_response_guarantee";
}>;

const DISCLAIMER = "no_emergency_response_guarantee" as const;

async function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

type BindingBytesInput = Readonly<{
  packageId: string;
  incidentId: string;
  fromStatus: AlertDeliveryStatus | "none";
  toStatus: AlertDeliveryStatus;
  authority: AlertEvidenceAuthority;
  recordedAt: string;
}>;

function bindingBytes(input: BindingBytesInput): Uint8Array {
  return utf8(
    JSON.stringify({
      v: 1,
      packageId: input.packageId,
      incidentId: input.incidentId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      authority: input.authority,
      recordedAt: input.recordedAt,
      disclaimer: DISCLAIMER,
    }),
  );
}

export async function createAlertEvidenceKey(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function mintStatusEvidence(input: {
  packageId: string;
  incidentId: string;
  fromStatus: AlertDeliveryStatus | "none";
  toStatus: AlertDeliveryStatus;
  authority: AlertEvidenceAuthority;
  evidenceKey: Uint8Array;
  now?: number;
}): Promise<AlertStatusEvidence> {
  const recordedAt = new Date(input.now ?? Date.now()).toISOString();
  const key = await importHmacKey(input.evidenceKey);
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      bindingBytes({ ...input, recordedAt } satisfies BindingBytesInput),
    ),
  );
  return {
    version: 1,
    packageId: input.packageId,
    incidentId: input.incidentId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    authority: input.authority,
    recordedAt,
    macB64: bytesToB64(mac),
    disclaimer: DISCLAIMER,
  };
}

export async function verifyStatusEvidence(
  evidence: AlertStatusEvidence,
  evidenceKey: Uint8Array,
): Promise<boolean> {
  if (evidence.disclaimer !== DISCLAIMER) return false;
  const key = await importHmacKey(evidenceKey);
  const { b64ToBytes } = await import("./bytes.js");
  return crypto.subtle.verify(
    "HMAC",
    key,
    b64ToBytes(evidence.macB64),
    bindingBytes(evidence),
  );
}

/**
 * Client-supplied `{ acknowledged: true }` without human authority evidence
 * is never accepted as human acknowledgement (INV-16).
 */
export function rejectUnauthenticatedHumanClaim(claim: {
  acknowledged?: boolean;
  authority?: AlertEvidenceAuthority;
  evidence?: AlertStatusEvidence;
}): void {
  if (claim.acknowledged === true) {
    if (claim.authority !== "human" || !claim.evidence) {
      throw new Error(
        "authority_mismatch: client ack claim is not human evidence",
      );
    }
    if (claim.evidence.toStatus !== "human_acknowledged") {
      throw new Error("authority_mismatch: evidence status mismatch");
    }
    if (claim.evidence.authority !== "human") {
      throw new Error("authority_mismatch: evidence authority is not human");
    }
  }
}
