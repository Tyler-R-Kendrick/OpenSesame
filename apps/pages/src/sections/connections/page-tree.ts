import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { isConnectionCatalogProvider } from "@opensesame/app-core/lib/connector-guidance.js";
import { unfinishedConnections } from "@opensesame/app-core/lib/identity-graph.js";
import { isManagedConnector } from "@opensesame/app-core/lib/managed-connectors.js";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  FEATURE_BINDING_CATEGORIES,
  connectorPath,
  isFeatureBindingCategory,
} from "@opensesame/app-core/sections/connections/shared.js";
import {
  type PageTreeLeaf,
  type PageTreeSource,
  pageToTree,
} from "../../lib/page-to-tree.js";

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

function matchesCatalog(provider: Provider, query: string): boolean {
  if (!query) return true;
  return `${provider.displayName} ${provider.id} ${CATEGORY_LABELS[provider.category]}`
    .toLocaleLowerCase()
    .includes(query);
}

/** Catalog groups in page order: category headings, then source order inside. */
export function catalogPageSections(
  providers: readonly Provider[],
  query = "",
): PageTreeSource[] {
  const normalized = query.trim().toLocaleLowerCase();
  const managed: Provider[] = [];
  const grouped = new Map<Provider["category"], Provider[]>();
  for (const provider of providers) {
    if (!isConnectionCatalogProvider(provider)) continue;
    if (!matchesCatalog(provider, normalized)) continue;
    if (isManagedConnector(provider.id)) {
      managed.push(provider);
      continue;
    }
    const items = grouped.get(provider.category) ?? [];
    items.push(provider);
    grouped.set(provider.category, items);
  }
  const groups: PageTreeSource[] = [];
  if (managed.length > 0) {
    groups.push({
      id: "managed",
      label: "Managed",
      href: "/connections#catalog-managed",
      items: managed.map((provider) =>
        leaf(
          provider.id,
          provider.displayName,
          connectorPath(provider.id),
          "catalog",
        ),
      ),
    });
  }
  for (const category of CATEGORY_ORDER) {
    if (isFeatureBindingCategory(category)) continue;
    if (!grouped.has(category)) continue;
    groups.push({
      id: category,
      label: CATEGORY_LABELS[category],
      href: `/connections#catalog-${category}`,
      items: (grouped.get(category) ?? []).map((provider) =>
        leaf(
          provider.id,
          provider.displayName,
          connectorPath(provider.id),
          "catalog",
        ),
      ),
    });
  }
  return groups;
}

/** Feature bindings live under Settings → Connections, not Add a connection. */
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
      href: `/settings/connections#${category}`,
      items: items.map((provider) =>
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
    .filter((connection) => connection.status !== "revoked")
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
      sections: catalogPageSections(list, catalogQuery),
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
