import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { Provider } from "../lib/connections.js";
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
import { useConnectionsNavigation } from "./ConnectionsNavigation.js";
import { PageTreeBranch } from "./PageTreeBranch.js";
import { SECTIONS, SectionRow, TreeRow } from "./RailRows.js";
import "./connections-tree.css";

export function ConnectionsTree({
  open,
  onToggle,
}: { open: boolean; onToggle: () => void }) {
  const { pathname, hash } = useLocation();
  const current =
    pathname + (hash || (pathname === "/connections" ? "#connected" : ""));
  const { providers, connections } = useConnectionsNavigation();
  const sources = connectionsPageSources(providers, connections);
  const catalog = sources.find((section) => section.id === "catalog");
  const outline = pageToTree(
    sources.filter((section) => section.id !== "catalog"),
  );
  return (
    <>
      <SectionRow
        section={SECTIONS[1]}
        open={open}
        active={pathname.startsWith("/connections")}
        branch={open}
        onToggle={onToggle}
      />
      {open ? (
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
      ) : null}
    </>
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
  const visible = pageToTree(limitPageTree(sections, limit));
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
