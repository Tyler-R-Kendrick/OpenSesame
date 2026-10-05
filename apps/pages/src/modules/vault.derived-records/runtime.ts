/**
 * `vault.derived-records` — every built-in item type other than the base
 * secret, passkey, certificate and drop. Each one projects onto the native
 * secret. The contribution is the creation surface (SURFACE-08): a record
 * already in the vault still opens when this capability is off.
 *
 * The definitions are packs (ADR 0165). The kinds are registered at once from
 * the pack index, which is in the bundle, so nothing here waits on the network;
 * the definitions are then queued behind them (one at a time, the main thread
 * handed back between each, told in the bell tray) from their own chunks of
 * this same origin — no other egress. A person who wants some of them, not
 * all, switches those in Settings › Vaults › Item types, which needs no
 * capability.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  DERIVED_ITEM_KINDS,
  derivedKindOrder,
  derivedKindSegment,
} from "@opensesame/app-core/lib/derived-item-kinds.js";
import { enablePacks } from "@opensesame/app-core/lib/type-packs/installer.js";
import { directoryOf, packEntry } from "@opensesame/vault-item-types";
import { createActivation } from "../activation.js";

export const CAPABILITY = "vault.derived-records";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    DERIVED_ITEM_KINDS.forEach((kind, index) => {
      const entry = packEntry(kind);
      if (entry === undefined) return;
      activation.register("item-kind", {
        kind,
        label: entry.title,
        segment: derivedKindSegment(kind, directoryOf(entry.plural, kind)),
        order: derivedKindOrder(kind, index),
      });
    });
    // Installed for this document, not remembered as a choice: the capability
    // being on is the reason, and turning it off must not leave switches the
    // person never pressed.
    enablePacks(DERIVED_ITEM_KINDS, { keep: false });
    return activation.handle();
  },
};
