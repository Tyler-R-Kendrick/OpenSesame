/**
 * Targets and routes the `connectors.external` capability contributes.
 *
 * Nothing here is in the core catalog: the module registers these as
 * `tutorial-target` and `tutorial-route` contributions when it activates, and
 * revokes them when it is disposed, so a plan without connectors has no
 * `nav.connections` for a guide to point at.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name, account address, connection label or any other value a
 * person authored — the whole catalog is handed to a model as page context.
 */

import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const CONNECTIONS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "connections.reload",
    description:
      "Re-reads the connection list. Use it after finishing an authorization somewhere else.",
    role: "action",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.connected",
    description:
      "The Connected panel: every provider connection this device currently holds, with its state and a way into its settings.",
    role: "surface",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.attention",
    description:
      "Panel listing connections that exist but cannot be used until a person finishes their authorization. Present only while at least one is unfinished.",
    role: "status",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.catalog",
    description:
      "The Add a connection panel: the provider catalog, grouped by category. Choosing a provider opens its own page.",
    role: "surface",
    routes: ["/connections"],
    capabilityId: "providers.list",
  },
  {
    id: "connections.provider-picker",
    description:
      "The / search command over the provider catalog. Matches a provider name, a category or a connector identifier.",
    role: "filter",
    routes: ["/connections"],
    capabilityId: "providers.list",
  },
  {
    id: "connections.custom",
    description:
      "Opens the form for describing a provider the catalog does not ship, so it can be connected like any other.",
    role: "ceremony",
    routes: ["/connections"],
    capabilityId: null,
  },
  {
    id: "connections.back",
    description:
      "Returns from one connector's page to the full Connections list.",
    role: "navigation",
    routes: ["/connections"],
    capabilityId: null,
  },
  {
    id: "connections.authorize",
    description:
      "The Authorization panel on a connector's page. This is where a connection is approved, or where an existing one reports what it is.",
    role: "ceremony",
    routes: ["/connections"],
    capabilityId: "connections.create",
  },
  {
    id: "connections.renew",
    description:
      "Renews the credential behind an active connection without asking for consent again. Present only while the connection can be refreshed.",
    role: "action",
    routes: ["/connections"],
    capabilityId: "connections.rotate",
  },
  {
    id: "connections.revoke",
    description:
      "Revokes a connection, cutting off every project and agent bound to it and asking the provider to invalidate the credential.",
    role: "action",
    routes: ["/connections"],
    capabilityId: "connections.remove",
  },
  {
    id: "connections.bindings",
    description:
      "The Who can use it panel: which identities, groups, devices, projects and agents may use this authorization. None of them receive the credential.",
    role: "surface",
    routes: ["/connections"],
    capabilityId: "connections.bindings",
  },
  {
    id: "settings.secret-configs",
    description:
      "Write-only intake for secret-config values. Keys and metadata are listed; values never come back out.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "configs.set",
  },
  {
    id: "settings.sync-targets",
    description:
      "Replication targets for the sealed store, and the control that triggers a run.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "sync_targets.trigger",
  },
  {
    id: "nav.connections",
    description:
      "Rail entry that opens Connections, where provider connections are added, tested and revoked.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
];

export const CONNECTIONS_ROUTES: readonly GuideRouteDescriptor[] = [
  {
    id: "/connections",
    title: "Connections — provider connections and their state",
  },
];
