/**
 * `sharing.drops` — one-time sealed drops (ADR 0062 / ADR 0118): the `drop`
 * item kind in the vault, and the opener for a drop link.
 *
 * The `/claim` route is not this module's (ADR 0140 plan step 8): it is the
 * always-on `identity.ceremonies` dispatcher, which takes the link out of the
 * address at boot and, for a drop (`#token=…&key=…`), draws the opener this
 * module hands it as a `claim-opener` contribution. On an installation
 * without drops nothing here is loaded and the route says so.
 *
 * Egress this module wraps (existing transport, user-initiated by the
 * person pressing Open drop / Share):
 *  - Identity API `/v1/claims`, `/v1/claims/{id}`, `/v1/claims/present` via
 *    `identityFetch` (`lib/vault/drop-transport.ts`) — or the device-native
 *    claim plane on this origin (`lib/vault/local-drop-claims.ts`, OPFS kv,
 *    no network) when Pages is the claim host.
 * No tutorial descriptors exist for drops yet.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { LOCAL_DROP_CLAIM_KEYS } from "@opensesame/app-core/lib/vault/local-drop-claims.js";
import { KIND_LABEL } from "@opensesame/vault-core";
import { IconDrop } from "../../components/Icons.js";
import { DropClaimScreen } from "../../screens/DropClaimScreen.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "sharing.drops";

/**
 * The claim plane's plaintext keys. Opening a drop reads them synchronously,
 * so they must be in the kv cache before the opener renders — and the core
 * boot does not pull them for an installation without drops.
 */
export const HYDRATE_KEYS: readonly string[] = LOCAL_DROP_CLAIM_KEYS;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);

    await ctx.hydrate(HYDRATE_KEYS);
    if (activation.disposed()) return activation.handle();

    activation.register("claim-opener", {
      id: "drop",
      link: "drop",
      Opener: DropClaimScreen,
      order: 50,
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
