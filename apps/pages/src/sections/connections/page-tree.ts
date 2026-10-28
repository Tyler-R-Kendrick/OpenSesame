import { byoProvidersFirst } from "@opensesame/app-core/lib/catalog-provider.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { isConnectionCatalogProvider } from "@opensesame/app-core/lib/connector-guidance.js";
import { unfinishedConnections } from "@opensesame/app-core/lib/identity-graph.js";
import { isManagedConnector } from "@opensesame/app-core/lib/managed-connectors.js";
import {
  CATEGORY_LABELS,
  FEATURE_BINDING_CATEGORIES,
  belongsToConnectedList,
  connectorPath,
  isFeatureBindingCategory,
} from "@opensesame/app-core/sections/connections/shared.js";
import {
  type PageTreeLeaf,
  type PageTreeSource,
  pageToTree,
} from "../../lib/page-to-tree.js";
import {
  curatedCatalogProviders,
  matchesCatalog,
} from "./catalog-selection.js";

function leaf(
  id: string,
  label: string,
  href: string,
  group?: string,
): PageTreeLeaf {
  const node: PageTreeLeaf = { id, label, href };
  if (group) {
    node.selectTo = `/connections#${group}-${encodeURIComponent(id)}`;
  }
  return node;
}

/** One flat, curated browse list. Tags live on the page tiles. */
export function catalogPageItems(
  providers: readonly Provider[],
  query = "",
): PageTreeLeaf[] {
  const normalized = query.trim().toLocaleLowerCase();
  return curatedCatalogProviders(providers, {
    includeFeatured: true,
    includeFamilies: true,
  })
    .filter((provider) => matchesCatalog(provider, normalized))
    .map((provider) =>
      leaf(
        provider.id,
        provider.displayName,
        connectorPath(provider.id),
        "catalog",
      ),
    );
}

/** Feature bindings live under Settings → Integrations, not Add a connection. */
export function featureBindingSections(
  providers: readonly Provider[],
): PageTreeSource[] {
  const grouped = new Map<Provider["category"], Provider[]>();
  for (const provider of providers) {
    if (!isConnectionCatalogProvider(provider)) continue;
    if (isManagedConnector(provider.id)) continue;
    if (!isFeatureBindingCategory(provider.category)) continue;
    const items = grouped.get(provider.category) ?? [];
    items.push(provider);
    grouped.set(provider.category, items);
  }
  const groups: PageTreeSource[] = [];
  for (const category of FEATURE_BINDING_CATEGORIES) {
    const items = grouped.get(category);
    if (!items) continue;
    groups.push({
      id: category,
      label: CATEGORY_LABELS[category],
      href: `/settings/integrations#${category}`,
      items: byoProvidersFirst(items).map((provider) =>
        leaf(
          provider.id,
          provider.displayName,
          connectorPath(provider.id, undefined, "/settings/connections"),
        ),
      ),
    });
  }
  return groups;
}

/**
 * The rail's Connected entries are the page's Connected rows: live
 * connection records, nothing else. Built-in keys that configure
 * themselves (WebCrypto, sealed local, plain) are Settings encryption keys
 * (connector-guidance: not catalog rows), and listing them here made the
 * rail say "Connected 3" beside a page that said "Nothing connected".
 */
export function connectedPageItems(
  _providers: readonly Provider[],
  connections: readonly Connection[],
): PageTreeLeaf[] {
  return connections
    .filter(belongsToConnectedList)
    .map((connection) =>
      leaf(
        connection.connectionId,
        connection.displayName,
        connectorPath(connection.providerId, connection.connectionId),
        "connected",
      ),
    );
}

/** Connections page: Needs attention, Connected, then catalog subheaders. */
export function connectionsPageSources(
  providers: readonly Provider[] | null,
  connections: readonly Connection[] | null,
  catalogQuery = "",
): PageTreeSource[] {
  const list = providers ?? [];
  const records = connections ?? [];
  const unfinished = unfinishedConnections(records);
  return [
    ...(unfinished.length
      ? [
          {
            id: "attention",
            label: "Needs attention",
            href: "/connections#attention",
            items: unfinished.map((connection) =>
              leaf(
                connection.connectionId,
                connection.displayName,
                connectorPath(connection.providerId, connection.connectionId),
                "attention",
              ),
            ),
          },
        ]
      : []),
    {
      id: "connected",
      label: "Connected",
      href: "/connections#connected",
      keepEmpty: true,
      items: connectedPageItems(list, records),
    },
    {
      id: "catalog",
      label: "Add a connection",
      href: "/connections#catalog",
      keepEmpty: true,
      items: catalogPageItems(list, catalogQuery),
    },
  ];
}

export function connectionsPageTree(
  providers: readonly Provider[] | null,
  connections: readonly Connection[] | null,
  catalogQuery = "",
) {
  return pageToTree(
    connectionsPageSources(providers, connections, catalogQuery),
  );
}
