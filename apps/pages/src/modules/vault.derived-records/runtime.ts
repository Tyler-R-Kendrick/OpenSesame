/**
 * `vault.derived-records` — every built-in item type other than the base
 * secret, passkey, certificate and drop. Each one projects onto the native
 * secret. The contribution is the creation surface (SURFACE-08): a record
 * already in the vault still opens when this capability is off.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  DERIVED_ITEM_KINDS,
  derivedKindOrder,
  derivedKindSegment,
} from "@opensesame/app-core/lib/derived-item-kinds.js";
import { itemTypeRegistry, typeLabel } from "@opensesame/vault-core";
import { directoryName } from "@opensesame/vault-item-types";
import { createActivation } from "../activation.js";

export const CAPABILITY = "vault.derived-records";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
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
