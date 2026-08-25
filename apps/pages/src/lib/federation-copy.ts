/**
 * One place that turns a federation failure into words a person can act on.
 *
 * Both the return screen and the unlock banners render from here, so the same
 * failure never reads two different ways — and no raw OAuth error code or
 * transport message reaches the screen unexplained.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { FederationError } from "./federation.js";

const BY_CODE = new Map<string, string>(
  Object.entries({
    access_denied:
      "Access was denied at the provider. Nothing was changed on this device.",
    no_identity_api:
      "This deployment isn't connected to an identity service yet. Add an Identity API URL to enable sign-in, or continue with a local-only vault.",
    upstream_unavailable:
      "The sign-in provider couldn't be reached. Check your connection and try again.",
    identity_unavailable:
      "The identity service couldn't be reached to finish signing in. Your provider sign-in itself worked — try again in a moment.",
    exchange_failed:
      "The provider refused to finish the sign-in. Try again; if it keeps happening, the provider may be misconfigured.",
    session_adoption_failed:
      "The identity service refused this sign-in. Try again from the start.",
    invalid_request:
      "This sign-in attempt is stale or was opened in a different tab. Start again from the sign-in screen.",
    expired: "That sign-in took too long and expired. Start it again.",
    issuer_mismatch:
      "The provider's response didn't come from where it claimed. Nothing was accepted.",
    untrusted_issuer:
      "The response came from a provider this app doesn't trust. Nothing was accepted.",
    audience_mismatch:
      "The provider's response was minted for a different app. Nothing was accepted.",
    invalid_token:
      "The provider returned an unusable sign-in token. Nothing was accepted.",
  }),
);

/** Friendly, actionable copy for any sign-in failure. */
export function describeFederationError(caught: BoundaryValue): string {
  if (caught instanceof FederationError) {
    const known = BY_CODE.get(caught.code);
    if (known) return known;
    // An upstream error code outside the map (e.g. a provider-specific OAuth
    // code): keep its own description, which FederationError already carries
    // in plain words, and anchor the outcome.
    return `${caught.message} Nothing was changed on this device.`;
  }
  if (caught instanceof Error && caught.message) return caught.message;
  return "Sign-in failed. Nothing was changed on this device.";
}
