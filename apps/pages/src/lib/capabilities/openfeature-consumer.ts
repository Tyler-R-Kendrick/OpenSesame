/**
 * Typed, advisory facade over the OpenFeature client (S17).
 *
 * ADVISORY ONLY. Nothing here decides whether a module may load or an
 * operation may run. Eligibility for loading and dispatch is decided by
 * `loader.ts` (`loadApprovedModule`) and `authority.ts`
 * (`assertCurrentOperationAuthority`), which read `compositionStore` directly
 * and never consult a flag. A `true` from the SDK — including one from a
 * provider somebody registered in place of ours — changes what a screen may
 * *show*; it never reaches the loader (OF-05).
 *
 * Every read passes a `false` default and exposes no default parameter, so
 * an unknown key, a not-ready provider or a type mismatch always reads as
 * "not enabled" (OF-03/OF-04).
 */
import { OpenFeature, ProviderEvents } from "@openfeature/web-sdk";
import type { CapabilityId } from "@opensesame/capability-composition";
import { useSyncExternalStore } from "react";
import { OPENFEATURE_DOMAIN, capabilityFlagKey } from "./openfeature.js";

function client() {
  return OpenFeature.getClient(OPENFEATURE_DOMAIN);
}

/** Whether the UI may show `id` as enabled. Never an authority decision. */
export function capabilityEnabled(id: CapabilityId): boolean {
  return client().getBooleanValue(capabilityFlagKey(id), false);
}

function subscribeToFlags(listener: () => void): () => void {
  const c = client();
  const handler = () => listener();
  c.addHandler(ProviderEvents.ConfigurationChanged, handler);
  c.addHandler(ProviderEvents.Ready, handler);
  c.addHandler(ProviderEvents.Stale, handler);
  c.addHandler(ProviderEvents.Error, handler);
  c.addHandler(ProviderEvents.ContextChanged, handler);
  return () => {
    c.removeHandler(ProviderEvents.ConfigurationChanged, handler);
    c.removeHandler(ProviderEvents.Ready, handler);
    c.removeHandler(ProviderEvents.Stale, handler);
    c.removeHandler(ProviderEvents.Error, handler);
    c.removeHandler(ProviderEvents.ContextChanged, handler);
  };
}

/** React binding of `capabilityEnabled`; re-renders on provider events. */
export function useCapabilityFlag(id: CapabilityId): boolean {
  return useSyncExternalStore(
    subscribeToFlags,
    () => capabilityEnabled(id),
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Release flags: a separate `release.<name>` namespace, resolved from a static
// compiled-in table. A release flag can hide UI that is not ready to ship; it
// can never enable a capability, widen a plan or reach the loader (OF-08).
// ---------------------------------------------------------------------------

export type ReleaseFlagState = "shown" | "restricted";
const RELEASE_PREFIX = "release.";

/**
 * The whole release table. Edit here, ship a build. Never read from a
 * provider, storage, the network or runtime config.
 */
export const RELEASE_FLAGS: Readonly<Record<string, ReleaseFlagState>> =
  Object.freeze({
    "release.composition-explain": "shown",
  });

export const releaseFlagSeams: {
  table: Readonly<Record<string, ReleaseFlagState>>;
} = { table: RELEASE_FLAGS };

export function isReleaseFlagName(name: string): boolean {
  return name.startsWith(RELEASE_PREFIX) && name.length > RELEASE_PREFIX.length;
}

/**
 * True when the UI behind `name` must stay hidden. An unknown or malformed
 * name restricts: a typo hides a screen, it never reveals one.
 */
export function releaseFlagRestricts(name: string): boolean {
  if (!isReleaseFlagName(name)) return true;
  const table = releaseFlagSeams.table;
  return !Object.hasOwn(table, name) || table[name] !== "shown";
}

/**
 * The only way the two namespaces meet: a release flag may subtract from what
 * the composition allows, never add to it.
 */
export function capabilityShown(id: CapabilityId, releaseFlag?: string): boolean {
  const enabled = capabilityEnabled(id);
  if (releaseFlag === undefined) return enabled;
  return enabled && !releaseFlagRestricts(releaseFlag);
}
