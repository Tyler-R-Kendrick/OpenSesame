/**
 * Allow guests — whether this installation offers the guest road at all.
 *
 * The guest road (continue as guest, the first-run Skip, the unlock footer)
 * is on by default everywhere and must never disappear by accident: not
 * because no Identity API is configured, not because a vault already exists
 * (AGENTS.md §5, ADR 0033). The only thing that removes it is this record,
 * written when the operator of the installation turns "Allow guests" off in
 * Settings › Capabilities. Absent, unreadable or malformed reads as allowed:
 * the failure direction of this switch is the guest road staying up.
 *
 * It lives under its own key beside `settings.v1`, so an edit to the ways
 * in (`applyWaysInPatch`) cannot drop it, and it is hydrated with the core
 * boot keys because the sign-in and unlock screens read it before any vault
 * is open. It is plaintext by necessity for the same reason, and it holds
 * nothing but the one boolean.
 */

import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { kvGet, kvSetDurable } from "./kv.js";

export const GUEST_ACCESS_KEY = "guest-access.v1";

const listeners = new Set<() => void>();

/** True unless an operator explicitly turned guests off. */
export function guestsAllowed(): boolean {
  const raw = kvGet(GUEST_ACCESS_KEY);
  if (raw === null) return true;
  try {
    const parsed = JSON.parse(raw) as BoundaryValue;
    return !(isJsonObject(parsed) && parsed.allowed === false);
  } catch {
    return true;
  }
}

/** Durable write; listeners hear it once the record is on disk. */
export async function setGuestsAllowed(allowed: boolean): Promise<void> {
  await kvSetDurable(GUEST_ACCESS_KEY, JSON.stringify({ allowed }));
  for (const listener of [...listeners]) listener();
}

export function subscribeGuestAccess(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
