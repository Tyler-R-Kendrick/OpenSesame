import { useState, useTransition } from "react";
import { useLocation, useNavigate } from "react-router";
import type { Provider } from "../lib/connections.js";
import { canConfigureAutomatically } from "../lib/connector-guidance.js";
import {
  CATEGORY_LABELS,
  connectorPath,
} from "../sections/connections/shared.js";
import { useConnectionsNavigation } from "./ConnectionsNavigation.js";
import { IconChevronRight } from "./Icons.js";
import { SECTIONS, SectionRow, TreeRow } from "./RailRows.js";
import "./connections-tree.css";

const PAGE_SIZE = 12;

export function ConnectionsTree({
  open,
  onToggle,
}: { open: boolean; onToggle: () => void }) {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const { providers, connections } = useConnectionsNavigation();
  const live = (connections ?? []).filter(
    (connection) => connection.status !== "revoked",
  );
  const current = pathname + (hash || "#connected");
  const branch = (id: string, label: string, count: number) => (
    <TreeRow
      child
      to={`/connections#${id}`}
      label={label}
      expanded={!closed.has(id)}
      selected={current === `/connections#${id}`}
      isActive={current === `/connections#${id}`}
      onToggle={() => {
        setClosed((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        navigate(`/connections#${id}`);
      }}
    >
      <IconChevronRight
        size={12}
        className={`railtree__caret${closed.has(id) ? "" : " is-open"}`}
      />
      <span className="railtree__name">{label}</span>
      <span className="railtree__count">{count || "-"}</span>
    </TreeRow>
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
        <div
          className="railtree__kids connections-tree__group"
          id="connections-tree"
        >
          {branch("connected", "Connected", live.length)}
          {!closed.has("connected") ? (
            <div
              className="railtree__kids connections-tree__group"
              id="connected-tree"
            >
              {live.map((connection) => {
                const to = connectorPath(
                  connection.providerId,
                  connection.connectionId,
                );
                return (
                  <ConnectorRow
                    key={connection.connectionId}
                    to={to}
                    anchor={`connected-${encodeURIComponent(connection.connectionId)}`}
                    label={connection.displayName}
                  />
                );
              })}
              {live.length === 0 ? (
                <span className="connections-tree__note">
                  No connected services
                </span>
              ) : null}
            </div>
          ) : null}
          {branch(
            "catalog",
            "Add a Connection",
            (providers ?? []).filter(
              (provider) => !canConfigureAutomatically(provider),
            ).length,
          )}
          {!closed.has("catalog") ? (
            <CatalogEntries providers={providers} />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ConnectorRow({
  to,
  anchor,
  label,
}: { to: string; anchor: string; label: string }) {
  const { pathname, hash } = useLocation();
  const selected = pathname === to || hash === `#${anchor}`;
  return (
    <TreeRow
      child
      level={3}
      to={to}
      selectTo={`/connections#${anchor}`}
      selected={selected}
      isActive={selected}
    >
      <span className="railtree__name">{label}</span>
    </TreeRow>
  );
}

function CatalogEntries({ providers }: { providers: Provider[] | null }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [pending, startTransition] = useTransition();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const matches = (providers ?? [])
    .filter(
      (provider) =>
        !canConfigureAutomatically(provider) &&
        `${provider.displayName} ${provider.id} ${CATEGORY_LABELS[provider.category]}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const more = Math.min(PAGE_SIZE, Math.max(0, matches.length - limit));

  return (
    <div className="railtree__kids connections-tree__group" id="catalog-tree">
      <input
        className="connections-tree__search"
        type="search"
        aria-label="Search available connectors"
        placeholder="Search connectors"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setLimit(PAGE_SIZE);
          navigate("/connections#catalog", { replace: true });
        }}
      />
      {matches.slice(0, limit).map((provider) => {
        const to = connectorPath(provider.id);
        return (
          <ConnectorRow
            key={provider.id}
            to={to}
            anchor={`catalog-${encodeURIComponent(provider.id)}`}
            label={provider.displayName}
          />
        );
      })}
      {more > 0 ? (
        <TreeRow
          child
          level={3}
          to="/connections#catalog-more"
          selected={hash === "#catalog-more"}
          isActive={hash === "#catalog-more"}
          busy={pending}
          onToggle={() => {
            if (!pending)
              startTransition(() => {
                setLimit((previous) => previous + PAGE_SIZE);
                const first = matches[limit];
                if (first)
                  navigate(
                    `/connections#catalog-${encodeURIComponent(first.id)}`,
                  );
              });
          }}
        >
          {pending ? "Loading connectors…" : `Load ${more} more`}
        </TreeRow>
      ) : null}
      {matches.length === 0 ? (
        <output className="connections-tree__note">
          {providers === null
            ? "Loading connectors…"
            : "No matching connectors"}
        </output>
      ) : null}
    </div>
  );
}
