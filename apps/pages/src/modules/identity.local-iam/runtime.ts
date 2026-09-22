/**
 * `identity.local-iam` — this device as an identity host: the Identity
 * section it hosts (its rail row `g i`, the `/identity` route and the
 * Applications tab), the local application sign-in ceremony at
 * `/identity/authorize`, local passkeys, local identity sessions and grants.
 * Devices is here too: its list is the browsers that unlocked this vault.
 * The other identity tabs are contributed by `identity.federation`
 * (Providers) and `enterprise.directory-provisioning` (People, Agents,
 * Organization) through `sections/identity/identity-views.ts`.
 *
 * Egress: none. Every record is sealed in the tomb; the only navigation is
 * the redirect back to a registered local application after consent
 * (`user-mediated-navigation`), started by the person's approval.
 *
 * Side effects removed from import: the three `onVaultLock` subscriptions in
 * `lib/local-passkeys.ts`, `lib/local-sessions.ts` and
 * `lib/local-authorization.ts` are bound in `activate` (`lock-resets.ts`).
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { LocalAuthorize } from "../../screens/LocalAuthorize.js";
import { IdentitySection } from "../../sections/IdentitySection.js";
import { contributeIdentityViews } from "../../sections/identity/identity-views.js";
import {
  IDENTITY_ROUTES,
  IDENTITY_TARGETS,
} from "../../tutorial/registry/identity-catalog.js";
import { IDENTITY_GOALS } from "../../tutorial/registry/identity-goals.js";
import { createActivation } from "../activation.js";
import { registerIdentityViewPaths } from "../identity-view-paths.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { pickById } from "../tutorial-pick-b.js";
import { IdentityRailTree } from "./IdentityRailTree.js";
import { bindLocalIamLockResets } from "./lock-resets.js";

export const CAPABILITY = "identity.local-iam";

/**
 * The Identity tabs this capability puts on the page.
 *
 * Devices is here because the list it leads with is local: the browsers and
 * installs that have unlocked *this vault*, read from the tomb, renamed and
 * removed with no Identity API in the picture (`LocalDevicesPanel`). It was
 * `enterprise.directory-provisioning`'s alone, so a household that ran
 * browser-local IAM and no directory had no way to see its own devices —
 * ADR 0090's rule read backwards, gating a panel on a service it does not
 * need. The directory's own device approval still arrives from that
 * capability, inside the same tab.
 */
export const IDENTITY_VIEWS_OWNED = ["devices", "service-accounts"] as const;

export const TUTORIAL = {
  // The tab strip is this capability's component (`IdentityTabs`), and a
  // target may be declared once, so the host declares every tab button it
  // can draw — including Devices, which it now draws by itself.
  targets: pickById(IDENTITY_TARGETS, [
    "nav.identity",
    "identity.devices",
    "identity.service-accounts",
  ]),
  goals: pickById(IDENTITY_GOALS, [
    "identity.local.agent.keys.manage",
    "identity.local.application.authorize",
    "identity.local.passkeys.manage",
    "identity.local.directory.manage",
  ]),
  routes: IDENTITY_ROUTES,
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.onDispose(bindLocalIamLockResets());
    activation.onDispose(contributeIdentityViews(IDENTITY_VIEWS_OWNED));

    activation.register("section", {
      id: "identity",
      to: "/identity",
      label: "Identity",
      segment: "identity",
      jump: "i",
      icon: "user",
      order: 40,
      Tree: IdentityRailTree,
    });
    activation.register("route", {
      id: "identity",
      path: "/identity",
      element: IdentitySection,
      framed: true,
      order: 40,
    });
    activation.register("route", {
      id: "identity-authorize",
      path: "/identity/authorize",
      element: LocalAuthorize,
      framed: true,
      order: 41,
    });
    activation.register("command-path", {
      path: "/identity",
      label: "Identity",
    });
    // One tab destination per Identity tab this capability puts on the page
    // (`IDENTITY_VIEWS_OWNED`). The Identity section is hosted here, but its
    // tabs belong to three capabilities, so each owner contributes its own
    // — a destination exists exactly while the tab behind it does.
    registerIdentityViewPaths(activation, IDENTITY_VIEWS_OWNED);
    activation.register("keymap-jump", { key: "i", path: "/identity" });
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
