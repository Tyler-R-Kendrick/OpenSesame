/**
 * `sharing.drops` — one-time sealed drops (ADR 0062 / ADR 0118): the
 * `/claim` page, which opens on a locked device with no vault key (the
 * claim key travels in the URL fragment and the payload is sealed to it),
 * and the `drop` item kind in the vault.
 *
 * Egress this module wraps (existing transport, user-initiated by the
 * person pressing Open once / Share):
 *  - Identity API `/v1/claims`, `/v1/claims/{id}`, `/v1/claims/present` via
 *    `identityFetch` (`lib/vault/drop-transport.ts`) — or the device-native
 *    claim plane on this origin (`lib/vault/local-drop-claims.ts`, OPFS kv,
 *    no network) when Pages is the claim host.
 * No tutorial descriptors exist for drops yet.
 */

import { IconDrop } from "../../components/Icons.js";
import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { DropClaimScreen } from "../../screens/DropClaimScreen.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "sharing.drops";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    // `gate: "any"`: rendered whether or not the vault is unlocked, the way
    // App.tsx served `/claim` outside the unlock gate. It holds no key.
    activation.register("route", {
      id: "claim",
      path: "/claim",
      element: DropClaimScreen,
      framed: false,
      order: 50,
      gate: "any",
    });
    activation.register("item-kind", {
      kind: "drop",
      label: "Drops",
      segment: "drops",
      Icon: IconDrop,
      order: 50,
    });

    return activation.handle();
  },
};
