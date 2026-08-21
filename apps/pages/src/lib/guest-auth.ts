/**
 * Guest login — no passkey or password. A provisional Identity session is
 * minted, then a claim ceremony is staged so registered auth can be attached
 * later without changing the principal id.
 */

import { connectProvisional, identityJson } from "./identity.js";
import { listNotices, pushNotice } from "./notices.js";
import { vaultStore } from "./vault/store.js";

export type GuestClaim = {
  claimId: string;
  claimToken: string;
  userCode: string;
  verificationUri: string;
};

let inFlightClaim: Promise<void> | null = null;

async function claimGuestAuthDefault(): Promise<void> {
  if (
    listNotices().some(
      (notice) => notice.kind === "guest_claim" && notice.claimToken,
    )
  ) {
    return;
  }
  if (inFlightClaim) return inFlightClaim;
  inFlightClaim = (async () => {
    try {
      const session = await connectProvisional();
      const claim = await identityJson<GuestClaim>("/v1/claims", {
        method: "POST",
        body: JSON.stringify({
          type: "principal",
          targetManifest: {
            principalId: session.principalId,
            purpose: "guest-auth",
          },
        }),
      });
      pushNotice({
        kind: "guest_claim",
        title: "Claim this guest session",
        body: "You skipped registered sign-in. Complete the claim ceremony to attach a passkey, password, or SSO account. The principal id stays the same.",
        userCode: claim.userCode,
        claimToken: claim.claimToken,
        verificationUri: claim.verificationUri,
      });
    } catch (caught) {
      pushNotice({
        kind: "guest_claim",
        title: "Claim this guest session",
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
  await vaultStore.createGuest();
  await claimGuestAuthDefault();
}

export const guestAuthSeams = {
  continueAsGuest: continueAsGuestDefault,
  claimGuestAuth: claimGuestAuthDefault,
};

export async function continueAsGuest(): Promise<void> {
  return guestAuthSeams.continueAsGuest();
}

export async function claimGuestAuth(): Promise<void> {
  return guestAuthSeams.claimGuestAuth();
}
