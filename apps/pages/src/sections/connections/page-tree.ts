import type { Connection, Provider } from "../../lib/connections.js";
import { canConfigureAutomatically } from "../../lib/connector-guidance.js";
import { unfinishedConnections } from "../../lib/identity-graph.js";
import {
  type PageTreeLeaf,
  type PageTreeSource,
  pageToTree,
} from "../../lib/page-to-tree.js";
import { CATEGORY_LABELS, CATEGORY_ORDER, connectorPath } from "./shared.js";

function leaf(
  id: string,
  label: string,
  href: string,
  group?: string,
): PageTreeLeaf {
  return {
    id,
    label,
    href,
    ...(group
      ? { selectTo: `/connections#${group}-${encodeURIComponent(id)}` }
      : {}),
  };
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
  const grouped = new Map<Provider["category"], Provider[]>();
  for (const provider of providers) {
    if (canConfigureAutomatically(provider)) continue;
    if (!matchesCatalog(provider, normalized)) continue;
    const items = grouped.get(provider.category) ?? [];
    items.push(provider);
    grouped.set(provider.category, items);
  }
  return CATEGORY_ORDER.filter((category) => grouped.has(category)).map(
    (category) => ({
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
    }),
  );
}

export function connectedPageItems(
  providers: readonly Provider[],
  connections: readonly Connection[],
): PageTreeLeaf[] {
  const live = connections.filter(
    (connection) => connection.status !== "revoked",
  );
  const automatic = providers.filter(canConfigureAutomatically);
  const automaticIds = new Set(automatic.map((provider) => provider.id));
  const managed = live.filter(
    (connection) => !automaticIds.has(connection.providerId),
  );
  return [
    ...automatic.map((provider) => {
      const connection = live.find((item) => item.providerId === provider.id);
      return leaf(
        connection?.connectionId ?? provider.id,
        provider.displayName,
        connectorPath(provider.id, connection?.connectionId),
        "connected",
      );
    }),
    ...managed.map((connection) =>
      leaf(
        connection.connectionId,
        connection.displayName,
        connectorPath(connection.providerId, connection.connectionId),
        "connected",
      ),
    ),
  ];
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
