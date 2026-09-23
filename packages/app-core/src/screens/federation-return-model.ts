import { ambientAuthSeams, isAmbientIntent } from "../lib/ambient-auth-seam.js";
import { storeAuthOutcome } from "../lib/auth-outcome.js";
/**
 * View-model logic for `FederationReturn` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import {
  adoptBrokeredSession,
  completeSignIn,
  displayName,
} from "../lib/federation.js";
import {
  adoptFederatedIdentity,
  openVaultAfterSignIn,
} from "../lib/guest-auth.js";
import { ensureIdentitySession } from "../lib/identity.js";
import { joinOrgTenant } from "../lib/orgs.js";

export type ReturnOutcome = { returnTo?: string };

export async function processReturn(): Promise<ReturnOutcome> {
  const result = await completeSignIn();
  if (!result) return {};
  if (isAmbientIntent(result.intent)) {
    return ambientAuthSeams.applyAmbientReturn({
      ...result,
      intent: result.intent,
    });
  }
  if (result.orgSlug && result.orgMethod) {
    await ensureIdentitySession();
    await joinOrgTenant(
      result.orgSlug,
      result.orgMethod,
      result.identity.idToken,
    );
    storeAuthOutcome({ kind: "linked", who: displayName(result.identity) });
  } else if (result.accessToken) {
    // Brokered sign-in (D8): the Identity API already decided which principal
    // this is when it issued the token, so the access token is traded for a
    // session bound to THAT principal. The id_token beside it is pairwise for
    // this origin and is deliberately never linked — doing so would attach it
    // to whichever session this tab holds (T23).
    await adoptBrokeredSession(result.accessToken);
    // A finished ceremony lands in the app, not back on the sign-in screen —
    // unless this leg is resuming somewhere specific (broker consent), where
    // inventing a vault would fake an unlocked state. When the vault stays
    // locked, the banner carries the outcome instead.
    const inApp =
      result.returnTo === undefined && (await openVaultAfterSignIn());
    if (!inApp) {
      storeAuthOutcome({ kind: "linked", who: displayName(result.identity) });
    }
  } else if (result.identity?.idToken) {
    // Attach the identity in whatever state this device is in: a true first
    // run opens a guest vault first, a locked vault defers to a notice rather
    // than binding the identity to a throwaway principal.
    const adopted = await adoptFederatedIdentity(result.identity.idToken);
    // An open vault means the person is inside the app and the bell already
    // carries anything unfinished — a stored banner would only resurface
    // stale on the next lock. A locked vault gets the banner — except for a
    // deferred link, which the bell's "finish attaching" prompt already owns.
    const inApp = await openVaultAfterSignIn();
    if (!inApp && adopted.kind !== "pending_link") {
      storeAuthOutcome(
        adopted.kind === "linked" || adopted.kind === "local"
          ? { kind: "linked", who: displayName(result.identity) }
          : {
              kind: "link_failed",
              detail: adopted.reason,
              who: displayName(result.identity),
            },
      );
    }
  }
  return result.returnTo !== undefined ? { returnTo: result.returnTo } : {};
}

export let inFlightReturn: Promise<ReturnOutcome> | null = null;

/** Test hook: drop a ceremony a previous test left unsettled. */
export function resetFederationReturnCeremony(): void {
  inFlightReturn = null;
}

/** The one shared ceremony; cleared once settled so a later sign-in reruns. */
export function runReturn(): Promise<ReturnOutcome> {
  if (!inFlightReturn) {
    inFlightReturn = processReturn().finally(() => {
      inFlightReturn = null;
    });
  }
  return inFlightReturn;
}
