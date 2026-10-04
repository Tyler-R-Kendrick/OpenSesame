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

import { subscribeDeviceRoutes } from "@opensesame/app-core/lib/device-identity-routes.js";
import {
  type IdentityPlaneKind,
  type IdentityRouteFamily,
  identityPlane,
  identityServes,
} from "@opensesame/app-core/lib/identity-plane.js";
import { isRemoteIdentityConfigured } from "@opensesame/app-core/lib/identity.js";
import { useSyncExternalStore } from "react";
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
 * Which Identity plane is answering: this device or a remote service (ADR
 * 0160). Re-reads when Settings changes the Identity address.
 */
export function useIdentityPlane(): IdentityPlaneKind {
  useSettingsEpoch();
  return identityPlane();
}

/**
 * Does the plane that is answering serve what this panel needs?
 *
 * The question a panel should ask instead of "is a remote URL set?" whenever
 * the device can answer too: a feature-scoped check against ADR 0160's truth
 * table. Remote-only features (org sign-in, magic link, email and text codes,
 * wallet, a federated callback) keep `useIdentityConfigured`, because they
 * need a server and a device answering would be a lie.
 *
 * It re-reads on a Settings change and when a capability registers or
 * removes a device route family: a capability activates asynchronously, and a
 * panel that drew first must not stay without what arrived a moment later.
 */
export function useIdentityServes(family: IdentityRouteFamily): boolean {
  useSettingsEpoch();
  return useSyncExternalStore(subscribeDeviceRoutes, () =>
    identityServes(family),
  );
}
