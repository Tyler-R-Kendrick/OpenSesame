/**
 * `vault.security-checks` — breach and two-step checks of the open vault's
 * logins (`lib/vault/security-checks.ts`). Turning it on publishes an idle
 * standing (Password health and this panel both read it) and draws the
 * check in two places: the Capabilities section, where the switch is, and
 * Settings › Vaults. Nothing is fetched until a person presses Check.
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
import {
  clearSecurityWatch,
  noteSecurityWatch,
} from "@opensesame/app-core/lib/vault/security-checks.js";
import { createActivation } from "../activation.js";
import { securityChecksPanel } from "./SecurityChecksPanel.js";

/** Matches `sectionCategory("feature-security-checks")`. */
const SECTION_CATEGORY = "capabilities.feature-security-checks";

export const CAPABILITY = "vault.security-checks";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.onDispose(() => clearSecurityWatch());
    noteSecurityWatch({ phase: "idle" });
    const range = { capability: CAPABILITY, purpose: PWNED_PURPOSE };
    const list = { capability: CAPABILITY, purpose: TWO_FACTOR_PURPOSE };
    const Panel = securityChecksPanel({
      range: (url, init) => ctx.egress.fetch(url, init, range),
      twoFactor: (url, init) => ctx.egress.fetch(url, init, list),
    });
    activation.register("settings-panel", {
      id: "vault-security-checks",
      label: "Breach and two-step checks",
      category: "vaults",
      Panel,
      order: 70,
    });
    activation.register("settings-panel", {
      id: "capability-security-checks",
      label: "Breach and two-step checks",
      category: SECTION_CATEGORY,
      Panel,
      order: 10,
    });
    return activation.handle();
  },
};
