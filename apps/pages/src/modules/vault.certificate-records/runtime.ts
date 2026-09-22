/**
 * `vault.certificate-records` — certificate records kept in the vault as
 * items (the `certificate` kind). It contributes the item kind only; CA
 * administration is `enterprise.ca-administration`, and nothing here signs
 * or issues.
 *
 * Egress: none.
 */

import { IconShield } from "../../components/Icons.js";
import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "vault.certificate-records";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.register("item-kind", {
      kind: "certificate",
      label: "Certificates",
      segment: "certs",
      Icon: IconShield,
      order: 70,
    });
    return activation.handle();
  },
};
