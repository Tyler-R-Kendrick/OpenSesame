/**
 * The app's safe state predicates.
 *
 * Every one of these answers a question about arrival or availability — did
 * the person reach this area, is that plane up, is the vault open. None of
 * them reads a field, an item, a folder name, an address or anything else a
 * person authored, which is why the whole set can be handed to a model as
 * page context and waited on by a guide.
 *
 * They must also be safe to read at any moment, including while the vault is
 * locked: `readGuidePredicate` is called from a wait loop that has no idea
 * what the app is doing, so a predicate that threw would take the guide with
 * it.
 */

import { connectivitySnapshot } from "../../lib/connectivity-monitor.js";
import { currentSession } from "../../lib/identity.js";
import { vaultStore } from "../../lib/vault/store.js";
import {
  type GuideRouteId,
  guideRouteForPath,
  guideRouteWithin,
} from "./routes.js";
import {
  announceGuideStateChange,
  declareGuidePredicate,
  isKnownGuidePredicate,
} from "./state.js";
import type { GuidePredicateDescriptor } from "./state.js";

/**
 * Whether the Connections area is currently showing at least one live
 * connection. The Host's connection list is only ever fetched asynchronously,
 * so the section publishes the coarse answer here rather than a predicate
 * pretending it can read it synchronously. A count, never a name.
 */
let connectionsPresent = false;

export function noteGuideConnectionsPresent(present: boolean): void {
  if (connectionsPresent === present) return;
  connectionsPresent = present;
  announceGuideStateChange();
}

function currentRoute(): GuideRouteId {
  return guideRouteForPath(window.location.pathname);
}

function onRoute(prefix: GuideRouteId): boolean {
  return guideRouteWithin(currentRoute(), prefix);
}

function vaultUnlocked(): boolean {
  return vaultStore.getSnapshot().status === "unlocked";
}

export const GUIDE_PREDICATES: readonly GuidePredicateDescriptor[] = [
  {
    id: "vault.unlocked",
    description: "The vault is open and its key is held in memory.",
    read: vaultUnlocked,
  },
  {
    id: "vault.empty",
    description:
      "The vault is showing no items at all. True while it is locked, because nothing is decrypted to show.",
    read: () =>
      vaultStore.getSnapshot().items.every((item) => item.deletedAt !== null),
  },
  {
    id: "route.vault",
    description: "The person is somewhere in the Vault section.",
    read: () => onRoute("/vault"),
  },
  {
    id: "route.vault.health",
    description: "The person is on the password health report.",
    read: () => onRoute("/vault/health"),
  },
  {
    id: "route.connections",
    description: "The person is somewhere in the Connections section.",
    read: () => onRoute("/connections"),
  },
  {
    id: "route.access",
    description: "The person is in the Access section.",
    read: () => onRoute("/access"),
  },
  {
    id: "route.identity",
    description: "The person is in the Identity section.",
    read: () => onRoute("/identity"),
  },
  {
    id: "route.settings",
    description: "The person is somewhere in Settings.",
    read: () => onRoute("/settings"),
  },
  {
    id: "route.settings.security",
    description: "The person is on the Security settings category.",
    read: () => onRoute("/settings/security"),
  },
  {
    id: "host.connected",
    description: "The Host plane answered its last reachability probe.",
    read: () => connectivitySnapshot().host.health === "reachable",
  },
  {
    id: "identity.connected",
    description: "An Identity session is held on this device right now.",
    read: () => currentSession() !== null,
  },
  {
    id: "connections.any",
    description:
      "The Connections section is showing at least one connection that has not been revoked.",
    read: () => connectionsPresent,
  },
  {
    id: "network.online",
    description: "This browser believes it has a network.",
    read: () => window.navigator.onLine,
  },
];

/**
 * Declares the whole set. The app calls this once at start-up; a second call
 * is a no-op rather than an error, so a hot reload does not take the page
 * down with `guide_predicate_declared_twice`.
 */
export function registerGuidePredicates(): void {
  for (const descriptor of GUIDE_PREDICATES) {
    if (isKnownGuidePredicate(descriptor.id)) continue;
    declareGuidePredicate(descriptor);
  }
}

export function guidePredicateDescriptors(): readonly GuidePredicateDescriptor[] {
  return GUIDE_PREDICATES;
}
