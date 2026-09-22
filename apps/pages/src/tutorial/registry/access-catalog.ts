/**
 * Targets and routes the `access.authority` capability contributes.
 *
 * Registered as `tutorial-target` and `tutorial-route` contributions when the
 * module activates; absent from every catalog view on a plan without it.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name, account address or any other value a person authored —
 * the whole catalog is handed to a model as page context.
 */

import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const ACCESS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "access.grants",
    description:
      "The Grants tab: local application grants and optional delegations, their scope and expiry, with confirmed revocation.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "delegations.list",
  },
  {
    id: "access.requests",
    description:
      "The Requests tab: authorization asks waiting on a decision, alongside the offers this deployment has minted.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "relay.inbox",
  },
  {
    id: "access.sessions",
    description:
      "The Sessions tab: agent task runs currently executing on this device, and the way to terminate one.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "tasks.list",
  },
  {
    id: "access.connectors",
    description:
      "The Connectors tab: connectors read by reference from a Nango-compatible directory or brokered by OpenSesame, and who is bound to each — sync the directory, then Bind under a row.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connectors.bind",
  },
  {
    id: "access.resources",
    description:
      "The Resources tab: the connections and registered sites that a grant can be pointed at.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connections.list",
  },
  {
    id: "access.policies",
    description:
      "The Policies tab: how broadly each authorization may be delegated and invoked.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connections.update",
  },
  {
    id: "access.grant-access",
    description:
      "Starts the grant ceremony: pick what is being shared, narrow the scope, decide who it is for, then mint a claim code.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "delegations.offers.mint",
  },
  {
    id: "access.grant-ceremony",
    description:
      "The grant ceremony itself: pick what is shared, narrow the scope, decide who it is for, mint a claim code.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "delegations.offers.mint",
  },
  {
    id: "access.relay",
    description:
      "Pending relay approval requests: a person decides whether a running agent may continue.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "relay.decide",
  },
  {
    id: "nav.access",
    description:
      "Rail entry that opens Access, where delegations, share offers and running agent tasks are reviewed.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
];

export const ACCESS_ROUTES: readonly GuideRouteDescriptor[] = [
  { id: "/access", title: "Access — delegations, offers and running tasks" },
];
