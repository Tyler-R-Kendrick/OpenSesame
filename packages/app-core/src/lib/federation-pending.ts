/**
 * Legacy single-slot PKCE pending record. Ambient transactions live in
 * `ambient-auth/transactions.ts`; this module keeps explicit sign-in
 * compatibility, including PWA handoff via localStorage.
 */

import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { localStore, sessionStore } from "../ports.js";
import { type PendingAuth, asPendingAuth } from "./federation-pending-auth.js";
import {
  dropPkcePending,
  readPkcePendingRaw,
} from "./federation-pkce-pending-slot.js";

export const PKCE_KEY = "opensesame:federation:pkce";
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export type { PendingAuth };

export type TakenPending = {
  pending: PendingAuth | null;
  stale: boolean;
  unmatched?: boolean;
};

function readRawPending() {
  return readPkcePendingRaw(PKCE_KEY);
}

function dropRawPending(): void {
  dropPkcePending(PKCE_KEY);
}

function parsePending(raw: string): TakenPending {
  let parsed: BoundaryValue;
  try {
    parsed = overlapCast(JSON.parse(raw));
  } catch {
    return { pending: null, stale: true };
  }
  const pending = asPendingAuth(parsed);
  if (!pending) {
    return { pending: null, stale: true };
  }
  const createdAt = pending.createdAt;
  if (createdAt === undefined || Date.now() - createdAt > PENDING_MAX_AGE_MS) {
    return { pending: null, stale: true };
  }
  return { pending, stale: false };
}

export function peekPending(): TakenPending {
  const { raw, swapped } = readRawPending();
  if (swapped) return { pending: null, stale: true };
  if (!raw) return { pending: null, stale: false };
  return parsePending(raw);
}

export function consumePending(): void {
  dropRawPending();
}

export function storePending(pending: PendingAuth): void {
  // localStorage, not sessionStorage, ON PURPOSE: PWA handoff. Drop any
  // session copy so a second lane cannot shadow or swap the live record.
  sessionStore().removeItem(PKCE_KEY);
  // ast-grep-ignore: ts-localstorage-set
  localStore().setItem(
    PKCE_KEY,
    JSON.stringify({ ...pending, createdAt: Date.now() }),
  );
}

/**
 * Consume only when `state` matches a live record, or the record is stale.
 * An uncorrelated error/success must not erase another login.
 */
export function takeMatchingPending(state: string | null): TakenPending {
  const seen = peekPending();
  if (!seen.pending && !seen.stale) return seen;
  if (seen.stale) {
    consumePending();
    return seen;
  }
  if (!state || !seen.pending || state !== seen.pending.state) {
    return { pending: null, stale: false, unmatched: Boolean(seen.pending) };
  }
  consumePending();
  return seen;
}
