/**
 * `access.authority` — the Access section (the local PAM plane): grants,
 * requests, sessions, connectors, resources and policies, its rail subtree,
 * the `g a` jump, the `/agents` and `/sites` aliases that redirect here, and
 * the authored walkthroughs that point at its tabs.
 *
 * Egress this module wraps (existing transport, listed for the catalog):
 *  - Host API `/api/v1/tasks*`, `/api/v1/delegations*`, `/api/v1/relay*`,
 *    receipts and browser pairing via `hostFetch` — user-initiated on tab
 *    open, only when a Host is configured (`useHostConfigured`).
 *  - Identity API resources and session receipts via `identityFetch` — same
 *    condition on the Identity API.
 *  - Access › Connectors reads the Nango-compatible directory's two listing
 *    routes (`lib/connector-directory.ts`) — user-initiated Sync; that code
 *    is `connectors.external`'s, so the tab should follow that capability's
 *    approval (reported to wave A; not gated here).
 *  Everything under Grants / Requests / Policies is sealed local records:
 *  no network at all.
 *
 * Side effects: none at import. The section, the tree and every panel are
 * React components that read on mount.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";

import {
  ACCESS_ROUTES,
  ACCESS_TARGETS,
} from "@opensesame/app-core/tutorial/registry/access-catalog.js";
import { ACCESS_GOALS } from "@opensesame/app-core/tutorial/registry/access-goals.js";
import { AUTHORITY_GOALS } from "@opensesame/app-core/tutorial/registry/authority-help.js";
import { IDENTITY_TARGETS } from "@opensesame/app-core/tutorial/registry/identity-catalog.js";
import { IDENTITY_GOALS } from "@opensesame/app-core/tutorial/registry/identity-goals.js";
import { AccessSection } from "../../sections/AccessSection.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { pickById } from "../tutorial-pick-b.js";
import { AccessRailTree } from "./AccessRailTree.js";
import { AccessRedirect } from "./AccessRedirect.js";

import {
  ACCESS_LABELS,
  ACCESS_VIEWS,
} from "@opensesame/app-core/lib/section-view-names.js";
export const CAPABILITY = "access.authority";

/**
 * Authored beside the registry: the Access partition whole, the Host
 * authority walkthroughs, plus the identity-partition entries whose
 * operations the catalog lists under this capability (the local request,
 * policy and access walkthroughs all navigate to `/access`; the claim
 * ceremony on the Identity page exercises `delegations.claim`).
 */
export const TUTORIAL = {
  targets: [
    ...ACCESS_TARGETS,
    ...pickById(IDENTITY_TARGETS, ["identity.claim-access"]),
  ],
  goals: [
    ...ACCESS_GOALS,
    ...AUTHORITY_GOALS,
    ...pickById(IDENTITY_GOALS, [
      "identity.local.requests.manage",
      "identity.local.policy.manage",
      "identity.local.access.manage",
      "authority.portal.templates.manage",
      "authority.portal.templates.read",
    ]),
  ],
  routes: ACCESS_ROUTES,
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("section", {
      id: "access",
      to: "/access",
      label: "Access",
      segment: "access",
      jump: "a",
      icon: "authority",
      order: 30,
      Tree: AccessRailTree,
    });
    activation.register("route", {
      id: "access",
      path: "/access/:tab?/:rest?",
      element: AccessSection,
      framed: true,
      order: 30,
    });
    activation.register("route", {
      id: "agents-alias",
      path: "/agents",
      element: AccessRedirect,
      framed: false,
      order: 31,
    });
    activation.register("route", {
      id: "sites-alias",
      path: "/sites",
      element: AccessRedirect,
      framed: false,
      order: 32,
    });
    activation.register("command-path", { path: "/access", label: "Access" });
    // The section's six tabs are destinations too — the command bar and the
    // browser tool read the same `command-path` set, and a tab is reachable
    // exactly while the capability that draws it is in the plan. Every
    // Access tab is this one's: the panels behind them are its own.
    for (const view of ACCESS_VIEWS) {
      activation.register("command-path", {
        path: `/access?view=${view}`,
        label: `Access · ${ACCESS_LABELS[view]}`,
      });
    }
    activation.register("keymap-jump", { key: "a", path: "/access" });
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
