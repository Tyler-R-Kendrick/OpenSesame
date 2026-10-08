/**
 * Legacy single-slot PKCE pending record. Ambient transactions live in
 * `ambient-auth/transactions.ts`; this module keeps explicit sign-in
 * compatibility, including PWA handoff via localStorage.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { localStore, sessionStore } from "../ports.js";
import {
  dropPkcePending,
  readPkcePendingRaw,
} from "./federation-pkce-pending-slot.js";

export const PKCE_KEY = "opensesame:federation:pkce";
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

const MIN_VERIFIER_LEN = 43;
const MIN_STATE_LEN = 8;

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

function readRawPending() {
  return readPkcePendingRaw(PKCE_KEY);
}

function dropRawPending(): void {
  dropPkcePending(PKCE_KEY);
}

function asPendingAuth(value: BoundaryValue): PendingAuth | null {
  const raw = overlapCast(value);
  if (!isJsonObject(raw)) return null;
  if (
    !isString(raw.upstreamId) ||
    !isString(raw.issuer) ||
    !isString(raw.verifier) ||
    raw.verifier.length < MIN_VERIFIER_LEN ||
    !isString(raw.state) ||
    raw.state.length < MIN_STATE_LEN ||
    !isString(raw.tokenEndpoint) ||
    !isString(raw.jwksUri) ||
    !isString(raw.scope) ||
    !isNumber(raw.createdAt)
  ) {
    return null;
  }
  const pending: PendingAuth = {
    upstreamId: raw.upstreamId,
    issuer: raw.issuer,
    verifier: raw.verifier,
    state: raw.state,
    tokenEndpoint: raw.tokenEndpoint,
    jwksUri: raw.jwksUri,
    scope: raw.scope,
    createdAt: raw.createdAt,
  };
  if (isString(raw.sessionCheckEndpoint)) {
    pending.sessionCheckEndpoint = raw.sessionCheckEndpoint;
  }
  if (isString(raw.redirectUri)) {
    pending.redirectUri = raw.redirectUri;
  }
  if (isString(raw.clientId)) {
    pending.clientId = raw.clientId;
  }
  if (isString(raw.returnTo)) {
    pending.returnTo = raw.returnTo;
  }
  if (isString(raw.orgSlug)) {
    pending.orgSlug = raw.orgSlug;
  }
  if (raw.orgMethod === "sso" || raw.orgMethod === "saml") {
    pending.orgMethod = raw.orgMethod;
  }
  return pending;
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
