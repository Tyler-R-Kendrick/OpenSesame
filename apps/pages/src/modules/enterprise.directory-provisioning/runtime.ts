/**
 * `enterprise.directory-provisioning` — people, agents and devices in the
 * Identity API's directory. The Identity section is `identity.local-iam`'s;
 * this capability puts its four tabs on the page — People, Agents, Devices
 * and Organization (`sections/identity/identity-views.ts`) — and takes them
 * back on dispose, so an installation without it has no way into a panel
 * that can only talk to an Identity API.
 *
 * Egress: the configured Identity API's admin routes via `identityFetch`
 * (`lib/identity-management.ts`, `sections/identity/UsersPanel.tsx`,
 * `AgentsPanel.tsx`, `DevicesPanel.tsx`) — user-initiated on tab open and
 * on each change, only when an Identity API is configured. Every directory
 * change needs it; nothing here is local.
 *
 * Side effects: none at import. The panels read on mount.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { contributeIdentityViews } from "../../sections/identity/identity-views.js";
import { IDENTITY_TARGETS } from "../../tutorial/registry/identity-catalog.js";
import { IDENTITY_GOALS } from "../../tutorial/registry/identity-goals.js";
import { createActivation } from "../activation.js";
import { registerIdentityViewPaths } from "../identity-view-paths.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { pickById } from "../tutorial-pick-b.js";

export const CAPABILITY = "enterprise.directory-provisioning";

/** The Identity tabs this capability puts on the page. */
export const IDENTITY_VIEWS_OWNED = [
  "people",
  "agents",
  "devices",
  "organization",
] as const;

export const TUTORIAL = {
  targets: pickById(IDENTITY_TARGETS, [
    "identity.people",
    "identity.agents",
    "identity.devices",
    "identity.organization",
  ]),
  goals: pickById(IDENTITY_GOALS, [
    "identity.users.manage",
    "identity.agents.manage",
    "identity.device.approve",
  ]),
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.onDispose(contributeIdentityViews(IDENTITY_VIEWS_OWNED));
    // People, Agents, Devices and Organization are this capability's tabs, so
    // their destinations are its contributions too: with the Identity API
    // capability excluded, `/identity?view=devices` is not a place to go.
    registerIdentityViewPaths(activation, IDENTITY_VIEWS_OWNED);
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
