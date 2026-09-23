/**
 * `vault.certificate-records` — certificate records kept in the vault as
 * items (the `certificate` kind). It contributes the item kind only; CA
 * administration is `enterprise.ca-administration`, and nothing here signs
 * or issues.
 *
 * Egress: none.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { KIND_LABEL } from "@opensesame/vault-core";
import { IconShield } from "../../components/Icons.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "vault.certificate-records";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.register("item-kind", {
      kind: "certificate",
      // The picker reads it beside the core kinds, so it is the same
      // singular name the vault model already gives this kind.
      label: KIND_LABEL.certificate,
      segment: "certs",
      Icon: IconShield,
      order: 70,
    });
    return activation.handle();
  },
};
