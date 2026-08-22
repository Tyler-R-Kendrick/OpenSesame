/**
 * Guest login — no passkey or password. A provisional Identity session is
 * minted, then a registered-auth claim waits on the notifications bell.
 * Completing that claim POSTs the upstream id_token to Identity so the same
 * principalId is promoted (ADR 0033). The in-memory bearer is stashed across
 * the OIDC redirect because a navigation drops JS state.
 */

import {
  type IdentitySession,
  connectProvisional,
  currentSession,
  identityJson,
  restoreSession,
} from "./identity.js";
import { clearNotices, listNotices, pushNotice } from "./notices.js";
import { vaultStore } from "./vault/store.js";

const STASH_KEY = "opensesame:guest-claim-session";

const GUEST_NOTICE_TITLE = "Claim this guest session";
const GUEST_NOTICE_BODY =
  "You skipped registered sign-in. Sign in with a trusted account to attach it to this principal — the id stays the same.";

type StashedSession = {
  principalId: string;
  accessToken: string;
  issuerOrigin: string;
  expiresAt?: string;
};

export const guestAuthDependencies = {
  connectProvisional,
  currentSession,
  identityJson,
  restoreSession,
  createGuest: () => vaultStore.createGuest(),
};

function stashCurrentSessionDefault(): void {
  const active = guestAuthDependencies.currentSession();
  if (!active || active.cookieOnly) return;
  const payload: StashedSession = {
    principalId: active.principalId,
    accessToken: active.accessToken,
    issuerOrigin: active.issuerOrigin,
  };
  // Stryker disable next-line ConditionalExpression: equivalent — the payload
  // is only ever JSON.stringify'd, and that drops an undefined expiresAt.
  if (active.expiresAt) payload.expiresAt = active.expiresAt;
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify(payload));
  } catch {
    /* private mode — resumeCookieSession is the fallback */
  }
}

function takeStashedSessionDefault(): StashedSession | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    // Stryker disable next-line ConditionalExpression: equivalent — without the
    // fast path, JSON.parse(null) yields null and the field check below throws
    // into the same catch, so a missing record still reads as null.
    if (!raw) return null;
    sessionStorage.removeItem(STASH_KEY);
    // SAFETY: the serialized record is immediately checked for all required session fields below.
    const parsed = JSON.parse(raw) as StashedSession;
    if (!parsed.principalId || !parsed.accessToken || !parsed.issuerOrigin) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function restoreStashedGuestSessionDefault(): boolean {
  const stashed = takeStashedSessionDefault();
  if (!stashed) return false;
  const next: IdentitySession = {
    principalId: stashed.principalId,
    accessToken: stashed.accessToken,
    issuerOrigin: stashed.issuerOrigin,
  };
  if (stashed.expiresAt) next.expiresAt = stashed.expiresAt;
  guestAuthDependencies.restoreSession(next);
  return true;
}

let inFlightClaim: Promise<void> | null = null;

async function claimGuestAuthDefault(): Promise<void> {
  if (listNotices().some((notice) => notice.kind === "guest_claim")) {
    stashCurrentSession();
    return;
  }
  if (inFlightClaim) return inFlightClaim;
  inFlightClaim = (async () => {
    try {
      await guestAuthDependencies.connectProvisional();
      stashCurrentSession();
      pushNotice({
        kind: "guest_claim",
        title: GUEST_NOTICE_TITLE,
        body: GUEST_NOTICE_BODY,
      });
    } catch (caught) {
      pushNotice({
        kind: "guest_claim",
        title: GUEST_NOTICE_TITLE,
        body:
          caught instanceof Error
            ? `Continue as guest succeeded. Claim auth when Identity is reachable — ${caught.message}`
            : "Continue as guest succeeded. Claim auth from the notifications bell when you want a registered sign-in.",
      });
    }
  })().finally(() => {
    inFlightClaim = null;
  });
  return inFlightClaim;
}

async function continueAsGuestDefault(): Promise<void> {
  await guestAuthDependencies.createGuest();
  await claimGuestAuthDefault();
}

async function linkGuestAccountDefault(idToken: string): Promise<void> {
  restoreStashedGuestSessionDefault();
  if (!guestAuthDependencies.currentSession()) {
    await guestAuthDependencies.connectProvisional();
  }
  await guestAuthDependencies.identityJson("/v1/principals/link-identities", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
  clearNotices();
}

export const guestAuthSeams = {
  continueAsGuest: continueAsGuestDefault,
  claimGuestAuth: claimGuestAuthDefault,
  stashCurrentSession: stashCurrentSessionDefault,
  takeStashedSession: takeStashedSessionDefault,
  restoreStashedGuestSession: restoreStashedGuestSessionDefault,
  linkGuestAccount: linkGuestAccountDefault,
};

export async function continueAsGuest(): Promise<void> {
  return guestAuthSeams.continueAsGuest();
}

export async function claimGuestAuth(): Promise<void> {
  return guestAuthSeams.claimGuestAuth();
}

export function stashCurrentSession(): void {
  guestAuthSeams.stashCurrentSession();
}

export function takeStashedSession(): StashedSession | null {
  return guestAuthSeams.takeStashedSession();
}

export function restoreStashedGuestSession(): boolean {
  return guestAuthSeams.restoreStashedGuestSession();
}

export async function linkGuestAccount(idToken: string): Promise<void> {
  return guestAuthSeams.linkGuestAccount(idToken);
}
