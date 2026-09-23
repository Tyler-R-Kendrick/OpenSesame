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
    event.eventType.startsWith("connection.")
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
