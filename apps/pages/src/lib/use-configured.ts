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

import {
  hostBase,
  identityBase,
  isRemoteIdentityConfigured,
} from "./identity.js";
import { useSettingsEpoch } from "./use-settings.js";

export function useHostConfigured(): boolean {
  useSettingsEpoch();
  return hostBase().trim().length > 0;
}

/**
 * Is a remote OpenSesame Identity API configured?
 *
 * Also optional (ADR 0078 / 0118): the device-native identity host always
 * serves provisional sessions and claims in-tab. What a *remote* Identity API
 * adds is the networked control-plane — org SSO and SAML, magic links, hosted
 * OAuth client registration (Sites), and the directory APIs behind Identity ›
 * People when that plane is pointed at a server.
 *
 * Panels that talk those control-plane shapes ask this so a missing remote URL
 * keeps showing the browser-local directory, never a "Connect to Identity"
 * dead end over an empty remote API.
 */
export function useIdentityConfigured(): boolean {
  useSettingsEpoch();
  return isRemoteIdentityConfigured();
}

/**
 * Is any Identity plane available — remote URL or the device-native host?
 *
 * Prefer this for surfaces that speak `/v1/*` through `identityFetch` and are
 * backed on-device (Active project from vault projects). Prefer
 * `useIdentityConfigured` for control-plane-only roads.
 */
export function useIdentityPlane(): boolean {
  useSettingsEpoch();
  return identityBase().trim().length > 0;
}

/** @deprecated Prefer useIdentityConfigured — same remote-only meaning. */
export function useRemoteIdentityConfigured(): boolean {
  return useIdentityConfigured();
}
