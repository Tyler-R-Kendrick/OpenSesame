/**
 * `sharing.drops` — sending one-time sealed drops (ADR 0062 / ADR 0118): the
 * `drop` item kind in the vault, and the ceremony that seals a payload and
 * creates its claim session.
 *
 * Opening a drop is not this module's (ADR 0140 D2): the recipient's side —
 * the `/claim` route, the opener and `claims/drop-open.ts` — is the always-on
 * `identity.ceremonies`, so a drop link opens on every installation,
 * including one that cannot send drops.
 *
 * Egress this module wraps (existing transport, user-initiated by the
 * person pressing Share):
 *  - Identity API `/v1/claims` and `/v1/claims/{id}/poll` via `identityFetch`
 *    (`lib/vault/drop-transport.ts`) — or the device-native claim plane on
 *    this origin (`lib/vault/local-drop-claims.ts`, OPFS kv, no network)
 *    when Pages is the claim host.
 * No tutorial descriptors exist for drops yet.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { LOCAL_DROP_CLAIM_KEYS } from "@opensesame/app-core/lib/vault/local-drop-claims.js";
import { KIND_LABEL } from "@opensesame/vault-core";
import { IconDrop } from "../../components/Icons.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "sharing.drops";

/**
 * The device-native claim plane's plaintext keys. It reads them
 * synchronously, so they must be in the kv cache before a drop is created
 * or polled — and the core boot does not pull them for an installation
 * without drops.
 */
export const HYDRATE_KEYS: readonly string[] = LOCAL_DROP_CLAIM_KEYS;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);

    await ctx.hydrate(HYDRATE_KEYS);
    if (activation.disposed()) return activation.handle();

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
