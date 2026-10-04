/**
 * `vault.derived-records` — every built-in item type other than the base
 * secret, passkey, certificate and drop. Each one projects onto the native
 * secret. The contribution is the creation surface (SURFACE-08): a record
 * already in the vault still opens when this capability is off.
 *
 * The definitions are packs (ADR 0164): `activate` loads all of them, one at a
 * time, from their own chunks of this same origin — no other egress. A person
 * who wants some of them, not all, switches those in Settings › Vaults › Item
 * types, which needs no capability.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  DERIVED_ITEM_KINDS,
  derivedKindOrder,
  derivedKindSegment,
} from "@opensesame/app-core/lib/derived-item-kinds.js";
import { itemTypeRegistry, typeLabel } from "@opensesame/vault-core";
import { directoryName, loadPack } from "@opensesame/vault-item-types";
import { createActivation } from "../activation.js";

export const CAPABILITY = "vault.derived-records";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    // The definitions are packs (ADR 0164): the capability being on is the
    // cue to fetch them, one at a time so the page is never held.
    for (const kind of DERIVED_ITEM_KINDS) {
      await loadPack(kind).catch(() => undefined);
      if (activation.disposed()) return activation.handle();
    }
    const registry = itemTypeRegistry();
    DERIVED_ITEM_KINDS.forEach((kind, index) => {
      const definition = registry.get(kind);
      if (definition === undefined) return;
      activation.register("item-kind", {
        kind,
        label: typeLabel(kind),
        segment: derivedKindSegment(kind, directoryName(definition)),
        order: derivedKindOrder(kind, index),
      });
    });
    return activation.handle();
  },
};
