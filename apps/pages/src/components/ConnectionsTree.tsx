import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { pageToTree } from "../lib/page-to-tree.js";
import {
  CONNECTIONS_PAGE_SIZE,
  nextPageCount,
} from "../sections/connections/page-cap.js";
import {
  catalogPageItems,
  connectionsPageSources,
} from "../sections/connections/page-tree.js";
import { useRailConnections } from "./ConnectionsNavigation.js";
import { PageTreeBranch, PageTreeLeafRow } from "./PageTreeBranch.js";
import { TreeRow } from "./RailRows.js";
import "./connections-tree.css";

/** The entries under connections/: connected, attention, and the catalog. */
export function ConnectionsTreeEntries({ pathname }: { pathname: string }) {
  const { hash } = useLocation();
  const current =
    pathname + (hash || (pathname === "/connections" ? "#connected" : ""));
  const { providers, connections } = useRailConnections();
  const sources = connectionsPageSources(providers, connections);
  const catalog = sources.find((section) => section.id === "catalog");
  const outline = pageToTree(
    sources.filter((section) => section.id !== "catalog"),
  );
  return (
    <div className="railtree__kids" id="connections-tree">
      {outline.map((node) => (
        <PageTreeBranch
          key={node.id}
          node={node}
          level={2}
          current={current}
          empty={
            node.id === "connected" ? (
              <span className="connections-tree__note">
                No connected services
              </span>
            ) : null
          }
        />
      ))}
      {catalog ? (
        <PageTreeBranch
          node={{
            id: catalog.id,
            label: catalog.label,
            href: catalog.href,
            children: [],
            branch: true,
            count: catalog.items?.length ?? 0,
          }}
          level={2}
          current={current}
        >
          <CatalogEntries providers={providers} current={current} />
        </PageTreeBranch>
      ) : null}
    </div>
  );
}

/** Survives CatalogEntries remount when the catalog snapshot briefly clears. */
let catalogLeafLimit = CONNECTIONS_PAGE_SIZE;

function CatalogEntries({
  providers,
  current,
}: {
  providers: Provider[] | null;
  current: string;
}) {
  const [limit, setLimit] = useState(catalogLeafLimit);
  const navigate = useNavigate();
  const items = catalogPageItems(providers ?? []);
  const visible = items.slice(0, limit);
  const more = nextPageCount(items.length, limit);

  return (
    <>
      {visible.map((item) => (
        <PageTreeLeafRow
          key={item.id}
          node={{ ...item, children: [], branch: false }}
          level={3}
          current={current}
        />
      ))}
      {more > 0 ? (
        <TreeRow
          to="/connections#catalog-more"
          child
          level={3}
          onToggle={() => {
            const next = limit + CONNECTIONS_PAGE_SIZE;
            catalogLeafLimit = next;
            setLimit(next);
            const first = items[limit];
            if (first) {
              navigate(`/connections#catalog-${encodeURIComponent(first.id)}`);
            }
          }}
        >
          {`Load ${more} more`}
        </TreeRow>
      ) : null}
      {items.length === 0 ? (
        <output className="connections-tree__note">
          {providers === null
            ? "Loading connectors…"
            : "No matching connectors"}
        </output>
      ) : null}
    </>
  );
}
