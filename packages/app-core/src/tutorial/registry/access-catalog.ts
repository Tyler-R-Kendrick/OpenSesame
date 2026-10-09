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
      "The Grants branch: local application grants and optional delegations, their scope and expiry, with confirmed revocation.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "delegations.list",
  },
  {
    id: "access.requests",
    description:
      "The Requests branch: authorization asks waiting on a decision, alongside the offers this deployment has minted.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "relay.inbox",
  },
  {
    id: "access.sessions",
    description:
      "The Sessions branch: agent task runs currently executing on this device, and the way to terminate one.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "tasks.list",
  },
  {
    id: "access.connectors",
    description:
      "The Connectors branch: who may use which connector. Each record is a connector someone holds a grant on; Add chooses one Connections configured or imported, then who, which policy, until when.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connectors.bind",
  },
  {
    id: "access.resources",
    description:
      "The Resources branch: the connections and registered sites that a grant can be pointed at.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connections.list",
  },
  {
    id: "access.policies",
    description:
      "The Policies branch: how broadly each authorization may be delegated and invoked.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connections.update",
  },
  {
    id: "access.grant-access",
    description:
      "The add key on Identity shares: opens a share — who it is for, what it opens, the policy and how long it lasts.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "connectors.bind",
  },
  {
    id: "access.grant-ceremony",
    description:
      "The share form itself: who it is for, what is shared, the policy and how long it lasts.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "connectors.bind",
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
  { id: "/access/shares", title: "Access — identity shares and their add key" },
  { id: "/access/requests", title: "Access — requests waiting on a decision" },
  {
    id: "/access/resources",
    title: "Access — what a grant can be pointed at",
  },
  {
    id: "/access/policies",
    title: "Access — how broadly an application may ask",
  },
];
