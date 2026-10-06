/**
 * `vault.security-checks` — breach and two-step checks of the open vault's
 * logins (`lib/vault/security-checks.ts`). Settings › Vaults is the only
 * surface: the panel is registered here, so a plan that leaves the
 * capability off never loads it, and nothing is fetched until a person
 * presses its key.
 *
 * Egress, all through `ctx.egress` under the two declared purposes: Have I
 * Been Pwned's range API (five hex characters of a SHA-1 per request) and
 * 2fa.directory's site list (fetched whole). No site, username or password
 * is sent anywhere.
 */
import {
  PWNED_PURPOSE,
  TWO_FACTOR_PURPOSE,
} from "@opensesame/app-core/lib/capabilities/catalog-optional-vault.js";
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
import { securityChecksPanel } from "./SecurityChecksPanel.js";

export const CAPABILITY = "vault.security-checks";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    const range = { capability: CAPABILITY, purpose: PWNED_PURPOSE };
    const list = { capability: CAPABILITY, purpose: TWO_FACTOR_PURPOSE };
    activation.register("settings-panel", {
      id: "vault-security-checks",
      label: "Breach and two-step checks",
      category: "vaults",
      Panel: securityChecksPanel({
        range: (url, init) => ctx.egress.fetch(url, init, range),
        twoFactor: (url, init) => ctx.egress.fetch(url, init, list),
      }),
      order: 70,
    });
    return activation.handle();
  },
};
