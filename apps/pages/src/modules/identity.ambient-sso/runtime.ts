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

import {
  ambientAuthSeams,
  resetAmbientAuthSeams,
} from "@opensesame/app-core/lib/ambient-auth-seam.js";
import { runAmbientAuthBoot } from "@opensesame/app-core/lib/ambient-auth/boot.js";
import {
  clearAutoAuthSuppression,
  fenceLocalSignOut,
  isAutoAuthSuppressed,
} from "@opensesame/app-core/lib/ambient-auth/generation.js";
import { applyAmbientReturn } from "@opensesame/app-core/lib/ambient-auth/return-path.js";
import {
  applyDeployedAmbientPolicy,
  resetDeployedAmbientPolicy,
} from "@opensesame/app-core/lib/ambient-auth/runtime.js";
import { cancelAllTransactions } from "@opensesame/app-core/lib/ambient-auth/transactions.js";
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { isAuthCallbackSearch } from "@opensesame/app-core/lib/federation-callback.js";
import { AmbientAuthPanel } from "../../sections/settings/AmbientAuthPanel.js";
import { createActivation } from "../activation.js";
import type { ContextWithPorts } from "../ports-b.js";

export const CAPABILITY = "identity.ambient-sso";

/** Test seam: the boot evaluation, swappable without a module mock. */
export const ambientRuntimeSeams = {
  runAmbientAuthBoot,
  externalServicesDenied: () =>
    compositionStore.getSnapshot().plan?.network.externalServices !== "allow",
};

/** Test-only: forget that this document already booted. */
export function resetAmbientBootForTest(): void {
  boot.ran = false;
}

/**
 * One boot attempt, read from the document at job start rather than at
 * import: an already-aborted lease (a disable landing in the same tick)
 * reaches no provider at all.
 */
/**
 * A boot evaluation is once per document. Always on (ADR 0135), this module
 * is disposed and activated again on every plan generation — a feature
 * switched on elsewhere — and re-running the boot then would revalidate the
 * saved session and consider a silent attempt again for no reason.
 */
const boot = { ran: false };

export function startAmbientBoot(signal: AbortSignal): void {
  if (signal.aborted || boot.ran) return;
  // The first start decides for this document, run or not: a policy that
  // relaxes later does not start a boot in the middle of someone's session.
  boot.ran = true;
  // Always on is not a way round the operator's network envelope: the boot
  // is this capability's one automatic external call, and a plan that does
  // not allow external services — or no plan yet — keeps it off.
  if (ambientRuntimeSeams.externalServicesDenied()) return;
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

    // Core federation, sign-out and the return screen reach ambient SSO
    // only through this record, so none of them carries the Entra SDK into
    // a build that excluded the capability (ADR 0130 §4).
    Object.assign(ambientAuthSeams, {
      autoAuthSuppressed: isAutoAuthSuppressed,
      clearAutoAuthSuppression,
      fenceLocalSignOut,
      cancelAllTransactions,
      applyAmbientReturn,
    });
    activation.onDispose(resetAmbientAuthSeams);

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
    // draws. It arrives as a contribution rather than a static import, so a
    // build that excluded this capability carries neither the panel nor the
    // provider SDK behind it.
    activation.register("settings-panel", {
      id: "ambient-auth",
      category: "security",
      Panel: AmbientAuthPanel,
      order: 30,
    });

    return activation.handle();
  },
};
