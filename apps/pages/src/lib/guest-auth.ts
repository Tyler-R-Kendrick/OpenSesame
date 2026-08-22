/**
 * Guest login — no passkey or password. A provisional Identity session is
 * minted, then a registered-auth claim waits on the notifications bell.
 * Completing that claim POSTs the upstream id_token to Identity so the same
 * principalId is promoted (ADR 0033). The HttpOnly provisional cookie survives
 * the OIDC redirect; browser storage never receives the bearer.
 */

import { loadSession as loadFederationSession } from "./federation.js";
import {
  IdentityError,
  connectProvisional,
  currentSession,
  identityJson,
} from "./identity.js";
import { clearNotices, listNotices, pushNotice } from "./notices.js";
import { vaultStore } from "./vault/store.js";

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

export const guestAuthDependencies = {
  connectProvisional,
  currentSession,
  identityJson,
  createGuest: () => vaultStore.createGuest(),
  vaultStatus: () => vaultStore.getSnapshot().status,
  loadFederationSession,
};

/**
 * Presence check for a storage key that fails closed.
 *
 * Private mode, a spent quota, or a browser configured to block site data all
 * make `sessionStorage` *throw* rather than return null. A probe that cannot
 * read must answer "absent", never "present" — answering "present" would make
 * a locked-vault sign-in look resumable when nothing was stored.
 *
 * Exported only so a test can assert it returns exactly `false` on a throwing
 * store. Every caller negates the result, so `undefined` would behave
 * identically at every call site and the failure would be invisible.
 */
export function storedKeyPresent(key: string): boolean {
  try {
    return sessionStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function markPendingLink(): void {
  try {
    // A literal "1", not secret material: the rule guards against storing
    // something an XSS could exfiltrate, and the only thing this leaks is
    // that a link is pending, which the notice on screen already says.
    // ast-grep-ignore: ts-localstorage-set
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
  return storedKeyPresent(PENDING_LINK_KEY);
}

let inFlightClaim: Promise<void> | null = null;

async function claimGuestAuthDefault(): Promise<void> {
  if (listNotices().some((notice) => notice.kind === "guest_claim")) {
    return;
  }
  if (inFlightClaim) return inFlightClaim;
  inFlightClaim = (async () => {
    try {
      await guestAuthDependencies.connectProvisional();
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
  if (!guestAuthDependencies.currentSession()) {
    // Resume the server-authenticated HttpOnly cookie; no bearer crosses
    // browser storage while the upstream redirect is in progress.
    await guestAuthDependencies.connectProvisional();
  }
  await guestAuthDependencies.identityJson("/v1/principals/link-identities", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
  clearNotices();
}

/** A 409 from link-identities is the only outcome with its own plain words. */
function describeLinkFailure(caught: Error | null): string {
  if (caught instanceof IdentityError && caught.status === 409) {
    return COLLISION_MESSAGE;
  }
  return caught instanceof Error
    ? caught.message
    : "Attaching the account failed.";
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
        body: `Signed in on this device. Attach the account when Identity is reachable — ${describeLinkFailure(caught instanceof Error ? caught : null)}`,
      });
    }
    return;
  }

  if (status === "locked" && !guestAuthDependencies.currentSession()) {
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

export async function linkGuestAccount(idToken: string): Promise<void> {
  return guestAuthSeams.linkGuestAccount(idToken);
}

export async function adoptFederatedIdentity(idToken: string): Promise<void> {
  return guestAuthSeams.adoptFederatedIdentity(idToken);
}

export function recoverPendingFederatedLink(): void {
  guestAuthSeams.recoverPendingFederatedLink();
}
