/**
 * `identity.federation` — sign-in through operator-registered OpenID
 * providers, bring-your-own issuers and the Identity API's directory: the
 * Identity section's Providers tab, the setup ceremony's identity and MFA
 * tabs, and the `opensesame_identity_read` tool.
 *
 * The section itself is `identity.local-iam`'s; this capability only puts
 * its tab on the page (`sections/identity/identity-views.ts`) and takes it
 * back on dispose, so an installation without federation has no way into a
 * panel that would ask for an Identity API that is not there.
 *
 * Egress this module wraps (existing transport, listed for the catalog):
 *  - The configured Identity API's provider catalogue, org directory and
 *    MFA delivery routes via `identityFetch` (`lib/providers.ts`,
 *    `lib/directory.ts`, `lib/orgs.ts`, `lib/idp-registry.ts`) —
 *    user-initiated, only when an Identity API is configured.
 *  - The OpenID redirect to the provider a person pressed
 *    (`user-mediated-navigation`, `lib/federation.ts`'s operator legs).
 * The compiled-in Google-via-Shoo road is core sign-in, not this capability.
 *
 * Side effects: none at import. Every panel is a React component that reads
 * on mount; the setup tabs are only drawn once the ceremony opens them.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { IDENTITY_TARGETS } from "@opensesame/app-core/tutorial/registry/identity-catalog.js";
import { IDENTITY_GOALS } from "@opensesame/app-core/tutorial/registry/identity-goals.js";
import { IDENTITY_READ_TOOL } from "@opensesame/app-core/webmcp/identity-tools.js";
import { IdentityStep } from "../../screens/setup/steps/IdentityStep.js";
import { MfaStep } from "../../screens/setup/steps/MfaStep.js";
import { contributeIdentityViews } from "../../sections/identity/identity-views.js";
import { createActivation } from "../activation.js";
import { registerIdentityViewPaths } from "../identity-view-paths.js";
import { tagWebMcpTool } from "../ports-b.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { pickById } from "../tutorial-pick-b.js";

export const CAPABILITY = "identity.federation";

/** The Identity tabs this capability puts on the page. */
export const IDENTITY_VIEWS_OWNED = ["providers"] as const;

/**
 * Authored beside the registry (`identity-catalog.ts`, `identity-goals.ts`):
 * the Providers tab, registering an issuer, and adding an account through a
 * provider. `/federation` is `identity.local-iam`'s route descriptor — the
 * return screen is core sign-in — so it is not re-declared here.
 */
export const TUTORIAL = {
  targets: pickById(IDENTITY_TARGETS, [
    "identity.providers",
    "identity.register-idp",
  ]),
  goals: pickById(IDENTITY_GOALS, ["identity.account.add"]),
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.onDispose(contributeIdentityViews(IDENTITY_VIEWS_OWNED));

    // The Providers tab this capability puts on the page is a destination
    // the command bar and the browser tool may name, and only while it is.
    registerIdentityViewPaths(activation, IDENTITY_VIEWS_OWNED);

    activation.register("setup-panel", {
      id: "identity",
      tab: "identity",
      rail: "Identity",
      Panel: IdentityStep,
      order: 30,
    });
    activation.register("setup-panel", {
      id: "mfa",
      tab: "mfa",
      rail: "MFA",
      Panel: MfaStep,
      order: 40,
    });
    activation.register("webmcp-tool", tagWebMcpTool(IDENTITY_READ_TOOL));
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
