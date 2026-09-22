/**
 * `identity.ambient-sso` — silent sign-in on boot through Microsoft Entra or
 * another configured OpenID provider, and the returning-user opt-in under
 * Settings › Security. The MSAL redirect bridge (`auth/redirect.html`) is
 * this capability's HTML entry; a build without the capability does not emit
 * it, and `@azure/msal-browser` is reachable only through this module.
 *
 * Egress (automatic, declared): the configured provider's discovery,
 * authorization and token endpoints, attempted once per boot when the
 * eligibility ladder in `lib/ambient-auth/controller.ts` says the person is
 * a returning user who asked for it. The attempt never runs before the
 * capability is approved, because it is a `background-job` contribution the
 * loader starts under this lease and aborts with it.
 *
 * Top-level side effects removed: the boot evaluation used to be
 * `useAmbientAuthBoot()` called from `app-root`'s render
 * (`src/app-root.tsx`, before S05's extraction). It is now
 * `runAmbientAuthBoot()` (`lib/ambient-auth/boot.ts:69`) started here.
 * The deployment policy is applied here too — `ctx.runtimeConfig.ambientAuth`
 * is parsed data the core never applies — and forgotten on dispose, so
 * disabling the capability leaves no ambient providers on record.
 */

import { runAmbientAuthBoot } from "../../lib/ambient-auth/boot.js";
import { isAuthCallbackSearch } from "../../lib/ambient-auth/callback.js";
import {
  applyDeployedAmbientPolicy,
  resetDeployedAmbientPolicy,
} from "../../lib/ambient-auth/runtime.js";
import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { AmbientAuthPanel } from "../../sections/settings/AmbientAuthPanel.js";
import { createActivation } from "../activation.js";
import type { ContextWithPorts } from "../ports-b.js";

export const CAPABILITY = "identity.ambient-sso";

/** Test seam: the boot evaluation, swappable without a module mock. */
export const ambientRuntimeSeams = { runAmbientAuthBoot };

/**
 * One boot attempt, read from the document at job start rather than at
 * import: an already-aborted lease (a disable landing in the same tick)
 * reaches no provider at all.
 */
export function startAmbientBoot(signal: AbortSignal): void {
  if (signal.aborted) return;
  const { search, pathname } = window.location;
  ambientRuntimeSeams.runAmbientAuthBoot({
    hasAuthCallback: isAuthCallbackSearch(search),
    pathname,
  });
}

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(context) {
    const ctx = context as ContextWithPorts;
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    // Deployment data the core parsed and deliberately did not apply.
    if (ctx.runtimeConfig.ambientAuth !== undefined) {
      applyDeployedAmbientPolicy(ctx.runtimeConfig.ambientAuth);
      activation.onDispose(resetDeployedAmbientPolicy);
    }

    activation.register("background-job", {
      id: "ambient-auth-boot",
      start: startAmbientBoot,
    });

    // The opt-in row sits under the Security category the core already
    // draws; without the port the preference still applies, it is just not
    // offered here (ports-b.ts).
    const panel = ctx.registerSettingsPanel?.({
      id: "ambient-auth",
      category: "security",
      Panel: AmbientAuthPanel,
      order: 30,
    });
    if (panel) activation.onDispose(() => panel.revoke());

    return activation.handle();
  },
};
