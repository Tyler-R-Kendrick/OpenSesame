/**
 * Guest login — no passkey or password. A provisional Identity session is
 * minted, then a registered-auth claim waits on the notifications bell.
 * Completing that claim POSTs the upstream id_token to Identity so the same
 * principalId is promoted (ADR 0033). The in-memory bearer is stashed across
 * the OIDC redirect because a navigation drops JS state.
 */

import { loadSession as loadFederationSession } from "./federation.js";
import {
  IdentityError,
  type IdentitySession,
  connectProvisional,
  currentSession,
  identityJson,
  restoreSession,
} from "./identity.js";
import { clearNotices, listNotices, pushNotice } from "./notices.js";
import { vaultStore } from "./vault/store.js";

const STASH_KEY = "opensesame:guest-claim-session";
/**
 * Set while a verified upstream identity is waiting to be attached, cleared the
 * moment the link lands. Notices are in-memory and die on reload; this marker
 * is what lets the prompt be raised again for the same pending link without
 * inventing one on every reload of an already-linked session.
 */
const PENDING_LINK_KEY = "opensesame:federation:pending-link";

const GUEST_NOTICE_TITLE = "Claim this guest session";
const GUEST_NOTICE_BODY =
  "You skipped registered sign-in. Sign in with a trusted account to attach it to this principal — the id stays the same.";

const FEDERATED_NOTICE_TITLE = "Finish attaching your sign-in";
const FEDERATED_NOTICE_BODY =
  "You are signed in, but this device's vault was locked so the account was not attached yet. Unlock the vault, then finish from here.";

/**
 * Identity answers 409 when this upstream account is already bound to another
 * principal. Nothing the user can retry into — say so instead of leaking a
 * transport-shaped message.
 */
const COLLISION_MESSAGE =
  "That account is already attached to a different OpenSesame identity.";

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
  vaultStatus: () => vaultStore.getSnapshot().status,
  loadFederationSession,
};

function stashCurrentSessionDefault(): void {
  const active = guestAuthDependencies.currentSession();
  if (!active || active.cookieOnly) return;
  const payload: StashedSession = {
    principalId: active.principalId,
    accessToken: active.accessToken,
    issuerOrigin: active.issuerOrigin,
  };
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

/** Non-destructive: `takeStashedSession` consumes, this only looks. */
function hasStashedSession(): boolean {
  try {
    return sessionStorage.getItem(STASH_KEY) !== null;
  } catch {
    return false;
  }
}

function markPendingLink(): void {
  try {
    sessionStorage.setItem(PENDING_LINK_KEY, "1");
  } catch {
    /* private mode — the in-memory notice is the only prompt then */
  }
}

function clearPendingLink(): void {
  try {
    sessionStorage.removeItem(PENDING_LINK_KEY);
  } catch {
    /* nothing was stored */
  }
}

function pendingLinkMarked(): boolean {
  try {
    return sessionStorage.getItem(PENDING_LINK_KEY) !== null;
  } catch {
    return false;
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

/** A 409 from link-identities is the only outcome with its own plain words. */
function describeLinkFailure(caught: unknown): string {
  if (caught instanceof IdentityError && caught.status === 409) {
    return COLLISION_MESSAGE;
  }
  return caught instanceof Error ? caught.message : "Attaching the account failed.";
}

/**
 * Attach a verified upstream identity to a principal, whatever state this
 * device is in when the browser comes back from the upstream (ADR 0033 §4).
 *
 * Federation establishes *who you are* — it never decrypts the local E2EE
 * vault. On a true first run the vault is therefore created the same ephemeral
 * way "Continue as guest" creates one; sealing it with a passkey, PIN, or
 * password stays a later choice in Settings.
 */
async function adoptFederatedIdentityDefault(idToken: string): Promise<void> {
  const status = guestAuthDependencies.vaultStatus();

  if (status === "empty") {
    await guestAuthDependencies.createGuest();
    try {
      await linkGuestAccountDefault(idToken);
      clearPendingLink();
    } catch (caught) {
      // The user is already inside the app; throwing here would push them back
      // out of a sign-in that, from their side, worked. The verified assertion
      // survives in sessionStorage, so the bell can retry.
      markPendingLink();
      pushNotice({
        kind: "guest_claim",
        title: GUEST_NOTICE_TITLE,
        body: `Signed in on this device. Attach the account when Identity is reachable — ${describeLinkFailure(caught)}`,
      });
    }
    return;
  }

  if (
    status === "locked" &&
    !guestAuthDependencies.currentSession() &&
    !hasStashedSession()
  ) {
    // Minting a provisional principal here would bind this identity to a
    // throwaway — and if it is already bound to the real principal behind the
    // locked vault, Identity answers 409 and the link could never be made.
    markPendingLink();
    pushNotice({
      kind: "federated_link",
      title: FEDERATED_NOTICE_TITLE,
      body: FEDERATED_NOTICE_BODY,
    });
    return;
  }

  try {
    await linkGuestAccountDefault(idToken);
  } catch (caught) {
    if (caught instanceof IdentityError && caught.status === 409) {
      throw new Error(COLLISION_MESSAGE);
    }
    throw caught;
  }
  clearPendingLink();
}

/**
 * Re-raise the "finish attaching this sign-in" prompt after a reload. Notices
 * are in-memory, so a refresh drops them while the upstream assertion lives on
 * in sessionStorage. The prompt reuses the notifications bell's existing claim
 * button, which restarts sign-in and lands back in `adoptFederatedIdentity`
 * with the vault now open.
 */
function recoverPendingFederatedLinkDefault(): void {
  if (!pendingLinkMarked()) return;
  if (!guestAuthDependencies.loadFederationSession()) {
    // Expired, or the issuer's trust was withdrawn: nothing left to finish.
    clearPendingLink();
    return;
  }
  if (listNotices().some((notice) => notice.kind === "federated_link")) return;
  pushNotice({
    kind: "federated_link",
    title: FEDERATED_NOTICE_TITLE,
    body: FEDERATED_NOTICE_BODY,
  });
}

export const guestAuthSeams = {
  continueAsGuest: continueAsGuestDefault,
  claimGuestAuth: claimGuestAuthDefault,
  stashCurrentSession: stashCurrentSessionDefault,
  takeStashedSession: takeStashedSessionDefault,
  restoreStashedGuestSession: restoreStashedGuestSessionDefault,
  linkGuestAccount: linkGuestAccountDefault,
  adoptFederatedIdentity: adoptFederatedIdentityDefault,
  recoverPendingFederatedLink: recoverPendingFederatedLinkDefault,
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

export async function adoptFederatedIdentity(idToken: string): Promise<void> {
  return guestAuthSeams.adoptFederatedIdentity(idToken);
}

export function recoverPendingFederatedLink(): void {
  guestAuthSeams.recoverPendingFederatedLink();
}
