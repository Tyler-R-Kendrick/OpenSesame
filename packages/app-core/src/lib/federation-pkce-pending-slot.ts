/**
 * PKCE pending record storage across local and session stores (ADR 0149).
 * Kept apart from `federation-pending.ts` so the parser module stays within
 * the complexity ratchet.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { localStore, sessionStore } from "../ports.js";

function stateFromRaw(raw: string): string | null {
  try {
    const parsed: BoundaryValue = overlapCast(JSON.parse(raw));
    if (!isJsonObject(parsed)) return null;
    const state = parsed.state;
    return isString(state) ? state : null;
  } catch {
    return null;
  }
}

function pkcePendingStoresDisagree(
  localRaw: string,
  sessionRaw: string,
): boolean {
  const localState = stateFromRaw(localRaw);
  const sessionState = stateFromRaw(sessionRaw);
  return Boolean(localState && sessionState && localState !== sessionState);
}

export function dropPkcePending(key: string): void {
  localStore().removeItem(key);
  sessionStore().removeItem(key);
}

export function readPkcePendingRaw(key: string): {
  raw: string | null;
  swapped: boolean;
} {
  const localRaw = localStore().getItem(key);
  const sessionRaw = sessionStore().getItem(key);
  if (!localRaw && !sessionRaw) return { raw: null, swapped: false };
  if (
    localRaw &&
    sessionRaw &&
    pkcePendingStoresDisagree(localRaw, sessionRaw)
  ) {
    dropPkcePending(key);
    return { raw: null, swapped: true };
  }
  return { raw: localRaw ?? sessionRaw, swapped: false };
}
