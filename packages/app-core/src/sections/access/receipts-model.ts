/**
 * View-model logic for `receipts` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import { type JsonObject, isString } from "@opensesame/os-domain";

export type AuditEvent = {
  id: string;
  occurredAt: string;
  eventType: string;
  outcome: string;
  actorType?: string;
  clientId?: string;
  metadata?: JsonObject;
};

export function isReceiptEvent(event: AuditEvent): boolean {
  if (
    event.eventType.startsWith("agent.") ||
    event.eventType.startsWith("connection.") ||
    // What the device decided for its person (ADR 0162): requests, sign-ins
    // and connector grants are each a decision somebody made, so each is a
    // receipt.
    event.eventType.startsWith("access.")
  ) {
    return true;
  }
  if (event.actorType === "agent") return true;
  const instance = event.metadata?.agentInstanceId;
  return isString(instance) && instance.length > 0;
}

export const OUTCOME_CHIP = new Map([
  ["succeeded", "chip--ok"],
  ["denied", "chip--warn"],
  ["failed", "chip--err"],
]);

export function outcomeChip(outcome: string): string {
  return OUTCOME_CHIP.get(outcome) ?? "";
}

/**
 * The words for the decisions this device records (ADR 0162). Any other event
 * type, one an Identity API sent, is shown as it was named.
 */
const RECEIPT_LABELS: ReadonlyMap<string, string> = new Map([
  ["access.request.created", "Request raised"],
  ["access.request.approved", "Request approved"],
  ["access.request.denied", "Request denied"],
  ["access.request.withdrawn", "Request withdrawn"],
  ["access.sign_in.granted", "Application signed in"],
  ["access.sign_in.denied", "Application sign-in refused"],
  ["access.sign_in.revoked", "Application sign-in ended"],
  ["access.siop.approved", "Self-issued sign-in approved"],
  ["access.siop.denied", "Self-issued sign-in refused"],
  ["access.connection.granted", "Connection shared"],
  ["access.connection.revoked", "Connection share ended"],
]);

export function receiptLabel(eventType: string): string {
  return RECEIPT_LABELS.get(eventType) ?? eventType;
}

/** The thing a receipt is about, when its metadata names one. */
export function receiptTarget(
  event: AuditEvent,
): { type: string; id: string } | null {
  const type = event.metadata?.targetType;
  const id = event.metadata?.targetId;
  return isString(type) && isString(id) ? { type, id } : null;
}
