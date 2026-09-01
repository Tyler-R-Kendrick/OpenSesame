/**
 * The roads out of an account, and the one back in as somebody else.
 *
 * A device holds two separate ledgers: who is signed in (the Identity session
 * and the upstream assertion federation saved), and which key opens a vault.
 * Locking ends only the second. Nothing ended the first from inside the app —
 * the only sign-out was a link on the unlock screen's Sign in tab, and it
 * revoked the Identity session while leaving the shoo.dev assertion in web
 * storage, so the device still counted as signed in on the next load.
 *
 * `signOut` ends the first ledger whole and locks the second: there is no
 * reading of "sign out" under which the vault should stay open for whoever
 * is at the keyboard next. `switchAccount` is the same exit with the next
 * sign-in armed to ask the issuer afresh; `attachAccount` keeps the session
 * and asks the Sign in tab for another identity to link to it.
 *
 * Every one of these lands on the unlock screen's Sign in tab, which reads
 * the stored outcome and says what just happened (`PendingLinkBanner`).
 */

import { storeAuthOutcome } from "./auth-outcome.js";
import { clearSession as clearFederationSession } from "./federation.js";
import { forgetPendingLink } from "./guest-auth.js";
import { endSession } from "./identity.js";
import { vaultStore } from "./vault/store.js";

/**
 * Sign out of this device: forget the upstream assertion, revoke the Identity
 * session (bearer and HttpOnly cookie), drop any link waiting on an unlock,
 * and lock the vault.
 *
 * Order matters. The vault locks last so that lock handlers — which may
 * themselves call `endSession` under the strict preference — find nothing
 * left to end, and the outcome is stored before the lock so the unlock
 * screen that mounts on lock already knows why it is there.
 */
function signOutDefault(options: { switching?: boolean } = {}): void {
  clearFederationSession();
  forgetPendingLink();
  storeAuthOutcome(
    options.switching
      ? { kind: "signed_out", switching: true }
      : { kind: "signed_out" },
  );
  endSession();
  if (vaultStore.isUnlocked() || vaultStore.getSnapshot().awaitingTotp) {
    vaultStore.lock();
  }
}

/**
 * Sign out, then let the person sign in as somebody else. The next sign-in
 * carries `prompt=login` on every OIDC issuer; shoo.dev has no such flag and
 * answers with the Google account it remembers (see `BeginSignInOptions`).
 */
function switchAccountDefault(): void {
  signOutDefault({ switching: true });
}

/**
 * Attach another identity to the account this device already has. The
 * session stays; the vault locks, because the Sign in tab — the one surface
 * that offers every configured way in — lives on the unlock screen, and the
 * returning leg links the new identity to the principal that is still signed
 * in (`adoptFederatedIdentity`).
 */
function attachAccountDefault(): void {
  storeAuthOutcome({ kind: "attach" });
  if (vaultStore.isUnlocked()) vaultStore.lock();
}

export const sessionExitSeams = {
  signOut: signOutDefault,
  switchAccount: switchAccountDefault,
  attachAccount: attachAccountDefault,
};

export function signOut(): void {
  sessionExitSeams.signOut();
}

export function switchAccount(): void {
  sessionExitSeams.switchAccount();
}

export function attachAccount(): void {
  sessionExitSeams.attachAccount();
}
