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

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { LOCAL_DROP_CLAIM_KEYS } from "@opensesame/app-core/lib/vault/local-drop-claims.js";
import { KIND_LABEL } from "@opensesame/app-core/lib/vault/model.js";
import { IconDrop } from "../../components/Icons.js";
import { DropClaimScreen } from "../../screens/DropClaimScreen.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "sharing.drops";

/**
 * The claim plane's plaintext keys. `/claim` reads them synchronously on a
 * locked device, so they must be in the kv cache before the route renders —
 * and the core boot no longer pulls them for an installation without drops.
 */
export const HYDRATE_KEYS: readonly string[] = LOCAL_DROP_CLAIM_KEYS;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);

    await ctx.hydrate(HYDRATE_KEYS);
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
      // The picker reads it beside the core kinds, so it is the same
      // singular name the vault model already gives this kind.
      label: KIND_LABEL.drop,
      segment: "drops",
      Icon: IconDrop,
      order: 50,
    });

    return activation.handle();
  },
};
