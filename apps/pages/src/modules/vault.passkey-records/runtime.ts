/**
 * `vault.passkey-records` — passkey *records* kept in the vault as items
 * (the `passkey` kind: relying party, user handle, notes). It contributes
 * the item kind and nothing else: the browser-local passkey authenticator
 * (`sections/identity/LocalPasskeys.tsx`) belongs to `identity.local-iam`,
 * and unlocking with a passkey is core (`vault.local-unlock`).
 *
 * Egress: none.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { KIND_LABEL } from "@opensesame/vault-core";
import { IconPasskey } from "../../components/Icons.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "vault.passkey-records";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.register("item-kind", {
      kind: "passkey",
      // The picker reads it beside the core kinds, so it is the same
      // singular name the vault model already gives this kind.
      label: KIND_LABEL.passkey,
      segment: "passkeys",
      Icon: IconPasskey,
      order: 20,
    });
    return activation.handle();
  },
};
