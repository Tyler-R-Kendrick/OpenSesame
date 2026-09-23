/**
 * Is a plane configured for this deployment?
 *
 * Per ADR 0128 the Pages PWA no longer speaks Host: Connect and the sealed
 * local stores are the only live roads. `useHostConfigured` stays as a
 * compatibility shim that always returns false so leftover call sites keep
 * Host-gated panels dark rather than crashing on a removed export.
 *
 * Identity remains optional (ADR 0078 / 0118): the device-native identity
 * plane always serves provisional sessions and claims in-tab. What a remote
 * Identity API adds is the networked control-plane.
 */

import {
  identityBase,
  isRemoteIdentityConfigured,
} from "@opensesame/app-core/lib/identity.js";
import { useSettingsEpoch } from "./use-settings.js";

/** Always false — Pages no longer speaks Host (ADR 0128). */
export function useHostConfigured(): boolean {
  useSettingsEpoch();
  return false;
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
