/**
 * Is a plane configured for this deployment?
 *
 * A Host is optional (ADR 0090): this static app holds the vault, signs people
 * in and talks to its own connectors without one. What a Host adds is the
 * things a tab cannot do — brokered authority for callers that are not this
 * browser, and work that runs with no tab open (ADR 0078 §4).
 *
 * So this is the question a screen asks BEFORE it calls the Host, not after it
 * fails: a deployment with no Host must never be told that something could not
 * be read. It re-reads on every settings write, so pairing a daemon or filling
 * in Settings → Endpoints lights the Host-backed panels up without a reload.
 */

import { hostBase, identityBase } from "./identity.js";
import { useSettingsEpoch } from "./use-settings.js";

export function useHostConfigured(): boolean {
  useSettingsEpoch();
  return hostBase().trim().length > 0;
}

/**
 * Is an OpenSesame Identity API configured?
 *
 * Also optional (ADR 0078): sign-in runs against the compiled-in broker or a
 * provider the operator brought, both in this browser. What an Identity API
 * adds is the things a browser cannot do alone — org SSO and SAML, magic
 * links, provisional principals, and the OAuth clients a site registers.
 *
 * A panel asks this for the same reason it asks about a Host: so that "no
 * sites are registered here" never arrives dressed as "that client no longer
 * exists".
 */
export function useIdentityConfigured(): boolean {
  useSettingsEpoch();
  return identityBase().trim().length > 0;
}
