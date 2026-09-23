/**
 * Legacy single-slot PKCE pending record. Ambient transactions live in
 * `ambient-auth/transactions.ts`; this module keeps explicit sign-in
 * compatibility, including PWA handoff via localStorage.
 */

import { isNumber, overlapCast } from "@opensesame/os-domain";
import { localStore, sessionStore } from "../ports.js";

export const PKCE_KEY = "opensesame:federation:pkce";
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export type PendingAuth = {
  upstreamId: string;
  issuer: string;
  verifier: string;
  state: string;
  tokenEndpoint: string;
  jwksUri: string;
  scope: string;
  createdAt?: number;
  sessionCheckEndpoint?: string | undefined;
  redirectUri?: string;
  clientId?: string;
  returnTo?: string | undefined;
  orgSlug?: string | undefined;
  orgMethod?: "sso" | "saml" | undefined;
};

export type TakenPending = {
  pending: PendingAuth | null;
  stale: boolean;
  unmatched?: boolean;
};

function readRawPending(): string | null {
  return localStore().getItem(PKCE_KEY) ?? sessionStore().getItem(PKCE_KEY);
}

function dropRawPending(): void {
  localStore().removeItem(PKCE_KEY);
  sessionStore().removeItem(PKCE_KEY);
}

function parsePending(raw: string): TakenPending {
  let pending: PendingAuth | null;
  try {
    pending = overlapCast(JSON.parse(raw));
  } catch {
    return { pending: null, stale: true };
  }
  if (
    pending &&
    isNumber(pending.createdAt) &&
    Date.now() - pending.createdAt > PENDING_MAX_AGE_MS
  ) {
    return { pending: null, stale: true };
  }
  return { pending, stale: !pending };
}

export function peekPending(): TakenPending {
  const raw = readRawPending();
  if (!raw) return { pending: null, stale: false };
  return parsePending(raw);
}

export function consumePending(): void {
  dropRawPending();
}

export function storePending(pending: PendingAuth): void {
  // localStorage, not sessionStorage, ON PURPOSE: PWA handoff.
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
