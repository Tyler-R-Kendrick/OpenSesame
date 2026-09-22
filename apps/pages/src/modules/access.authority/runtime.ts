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

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { AccessSection } from "../../sections/AccessSection.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { AccessRailTree } from "./AccessRailTree.js";
import { AccessRedirect } from "./AccessRedirect.js";

export const CAPABILITY = "access.authority";

export const TUTORIAL = {
  targets: [
    "nav.access",
    "access.grants",
    "access.requests",
    "access.sessions",
    "access.connectors",
    "access.resources",
    "access.policies",
    "access.grant-access",
    "access.grant-ceremony",
    "access.relay",
  ],
  goals: [
    "access.grant",
    "access.claim",
    "access.relay",
    "access.sessions.review",
    "access.connectors",
    "identity.local.requests.manage",
    "identity.local.policy.manage",
    "identity.local.access.manage",
    "agent.observe",
    "agent.control",
  ],
  routes: ["/access"],
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
    activation.register("keymap-jump", { key: "a", path: "/access" });
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
