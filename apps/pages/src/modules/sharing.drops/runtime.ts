/**
 * `sharing.drops` — sending one-time sealed shares (ADR 0062 / ADR 0118).
 * The ceremony seals an item's secret and creates its claim session. A drop
 * is not an item kind. Legacy drop records still render and sweep.
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
 * Contributed: the Share once key's walkthrough
 * (`tutorial/registry/drops-catalog.ts`).
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { sweepDrops } from "@opensesame/app-core/lib/vault/drop.js";
import {
  LOCAL_DROP_CLAIM_KEYS,
  disposeExpiredLocalDropClaims,
} from "@opensesame/app-core/lib/vault/local-drop-claims.js";
import { OUTBOUND_DROPS_STORAGE_KEY } from "@opensesame/app-core/lib/vault/outbound-drops.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  DROPS_GOALS,
  DROPS_TARGETS,
} from "@opensesame/app-core/tutorial/registry/drops-catalog.js";
import { KIND_LABEL } from "@opensesame/vault-core";
import { IconShare } from "../../components/Icons.js";
import {
  DropRecord,
  ShareSecretDrop,
} from "../../sections/vault/DropCeremony.js";
import { createActivation } from "../activation.js";
import { anySignal, runUnlessAborted } from "../signals.js";
import { registerTutorial } from "../tutorial-contributions.js";

export const CAPABILITY = "sharing.drops";

/**
 * The device-native claim plane's plaintext keys. It reads them
 * synchronously, so they must be in the kv cache before a drop is created
 * or polled — and the core boot does not pull them for an installation
 * without drops.
 */
export const HYDRATE_KEYS: readonly string[] = [
  ...LOCAL_DROP_CLAIM_KEYS,
  OUTBOUND_DROPS_STORAGE_KEY,
];

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);

    await ctx.hydrate(HYDRATE_KEYS);
    if (activation.disposed()) return activation.handle();

    activation.register("item-kind", {
      kind: "drop",
      label: KIND_LABEL.drop,
      segment: "drops",
      Icon: IconShare,
      order: 50,
      creatable: false,
      Record: DropRecord,
    });
    activation.register("secret-share", {
      id: "drop",
      order: 10,
      Panel: ShareSecretDrop,
    });
    registerTutorial(activation, {
      targets: DROPS_TARGETS,
      goals: DROPS_GOALS,
    });
    // Disposal on unlock: a claimed or lapsed drop leaves the vault. It stops
    // between drops once the lease or this run's own signal aborts.
    activation.register("unlock-effect", {
      id: "drop-sweep",
      run: ({ signal }) => {
        const stop = anySignal([ctx.lease.signal, signal]);
        return runUnlessAborted(stop, async () => {
          disposeExpiredLocalDropClaims();
          await vaultStore.reconcileTrashedShares();
          await sweepDrops(
            vaultStore.getSnapshot().items,
            (id) => vaultStore.purgeItem(id),
            stop,
          );
        });
      },
    });

    return activation.handle();
  },
};
