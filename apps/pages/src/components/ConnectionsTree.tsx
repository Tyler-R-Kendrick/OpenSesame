import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  limitPageTree,
  pageToTree,
  pageTreeItemTotal,
  pageTreeLeaves,
} from "../lib/page-to-tree.js";
import {
  CONNECTIONS_PAGE_SIZE,
  nextPageCount,
} from "../sections/connections/page-cap.js";
import {
  catalogPageSections,
  connectionsPageSources,
} from "../sections/connections/page-tree.js";
import { useRailConnections } from "./ConnectionsNavigation.js";
import { PageTreeBranch } from "./PageTreeBranch.js";
import { SectionRow, type SectionTreeProps, TreeRow } from "./RailRows.js";
import "./connections-tree.css";

/**
 * The section row plus its entries — what the shell rendered before rail
 * sections became contributions. The `connectors.external` runtime
 * contributes `ConnectionsTreeEntries` alone; the shell draws the row.
 */
export function ConnectionsTree({ section, open, onToggle }: SectionTreeProps) {
  const { pathname } = useLocation();
  return (
    <>
      <SectionRow
        section={section}
        open={open}
        active={pathname.startsWith("/connections")}
        branch={open}
        onToggle={onToggle}
      />
      {open ? <ConnectionsTreeEntries pathname={pathname} /> : null}
    </>
  );
}

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
            count: pageTreeItemTotal(pageToTree(catalog.sections ?? [])),
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
  const sections = catalogPageSections(providers ?? []);
  const matches = pageTreeLeaves(pageToTree(sections));
  // Paging trims leaves, never groups: a group past the page keeps its row
  // and its whole count, so the rail names every category the page shows
  // (it used to stop at "Developer tools 3" with Productivity…CRM gone).
  const limited = limitPageTree(sections, limit);
  const visible = pageToTree(
    sections.map((section) => ({
      ...(limited.find((shown) => shown.id === section.id) ?? {
        ...section,
        items: [],
      }),
      keepEmpty: true,
      count: section.items?.length,
    })),
  );
  const more = nextPageCount(matches.length, limit);

  return (
    <>
      {visible.map((group) => (
        <PageTreeBranch
          key={group.id}
          node={group}
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
            const first = matches[limit];
            if (first) {
              navigate(`/connections#catalog-${encodeURIComponent(first.id)}`);
            }
          }}
        >
          {`Load ${more} more`}
        </TreeRow>
      ) : null}
      {matches.length === 0 ? (
        <output className="connections-tree__note">
          {providers === null
            ? "Loading connectors…"
            : "No matching connectors"}
        </output>
      ) : null}
    </>
  );
}
