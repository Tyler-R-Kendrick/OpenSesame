/**
 * What the page's broker did, kept in memory (ADR 0190 §9).
 *
 * Events are value-blind by construction (a key id, a client, a provider, a
 * stable reason: never a key, a proof or a prompt), so keeping them is safe,
 * but the page has no durable audit trail and does not grow one here: the
 * ring holds the most recent events and nothing else, dropping the oldest, and
 * is emptied when the keys it describes end. A reader gets frozen copies.
 */
import type { ModelKeyEvent } from "./types.js";

export const AUDIT_RING_CAPACITY = 200;

let ring: readonly ModelKeyEvent[] = [];

export function recordModelKeyEvent(event: ModelKeyEvent): void {
  ring = [...ring, Object.freeze({ ...event })].slice(-AUDIT_RING_CAPACITY);
}

/** The recorded events, oldest first. */
export function modelKeyAuditEvents(): readonly ModelKeyEvent[] {
  return [...ring];
}

export function clearModelKeyAuditEvents(): void {
  ring = [];
}
