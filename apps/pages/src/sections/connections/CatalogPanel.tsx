import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { isConnectionCatalogProvider } from "@opensesame/app-core/lib/connector-guidance.js";
import { isManagedConnector } from "@opensesame/app-core/lib/managed-connectors.js";
import {
  catalogTileNote,
  isVercelCatalogId,
  isVercelConnectable,
} from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { connectorPath } from "@opensesame/app-core/sections/connections/shared.js";
import { type ReactNode, useEffect } from "react";
import { Link, useLocation } from "react-router";
import { EmptyTip, emptyTips } from "../../components/EmptyTip.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconChevronRight,
  IconInfo,
  IconPlus,
  IconX,
} from "../../components/Icons.js";
import {
  SlashSearchField,
  SlashSearchKey,
  useListingSearch,
} from "../../components/SlashSearch.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ConnectorMark } from "./ConnectorMark.js";
import { catalogPageSections } from "./page-tree.js";

export function authKindLabel(provider: Provider): string {
  if (isManagedConnector(provider.id)) return "Managed";
  if (provider.id === "openrouter") return "Delegated sign-in";
  if (provider.authKind === "api_key") return "API key";
  if (provider.authKind === "configuration") return "Configuration";
  return "OAuth";
}

/** The connector catalog: search, category groups, brand-marked tiles. */
export function CatalogPanel({
  providers,
  connections = [],
}: {
  providers: Provider[] | null;
  connections?: Connection[];
}) {
  const search = useListingSearch();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash.startsWith("#catalog-")) search.close();
  }, [hash, search.close]);
  const panelRef = useGuideTarget<HTMLElement>("connections.catalog");
  const searchKeyRef = useGuideTarget<HTMLButtonElement>(
    "connections.provider-picker",
  );
  const customRef = useGuideTarget<HTMLAnchorElement>("connections.custom");
  const normalizedQuery = (search.query ?? "").trim().toLocaleLowerCase();
  const catalogProviders = (providers ?? []).filter(
    isConnectionCatalogProvider,
  );
  const grouped = catalogPageSections(catalogProviders, normalizedQuery);

  const sealKeyMissing = (providers ?? []).some((provider) =>
    provider.missingConfig.some((name) => name.includes("CONNECTION_KEY")),
  );

  return (
    <section id="catalog" className="panel" ref={panelRef}>
      <div className="panel__head conn-catalog__head">
        <h2>Add a connection</h2>
        <div className="conn-catalog__tools">
          <div className="vtree__keys">
            <SlashSearchKey
              navRef={searchKeyRef}
              onOpen={search.open}
              label="Search connectors"
            />
          </div>
          <Link
            ref={customRef}
            className="icon-btn"
            to="/connections/new"
            aria-label="Custom connector"
            title="Custom connector"
          >
            <IconPlus size={16} />
          </Link>
        </div>
      </div>

      <div className="panel__body">
        {providers === null ? (
          <p className="hint">Loading the connector catalog…</p>
        ) : (
          <>
            {sealKeyMissing ? (
              <p className="note note--warn conn-unconfigured">
                <IconInfo />
                Connection sealing is not available yet on this deployment. Ask
                an operator to finish setup, then try again.
              </p>
            ) : null}

            {grouped.map((group) => (
              <div className="conn-group" key={group.id}>
                <h3 className="conn-group__label" id={`catalog-${group.id}`}>
                  {group.label}
                </h3>
                <ul className="conn-grid">
                  {(group.items ?? []).map((item) => {
                    const provider = catalogProviders.find(
                      (entry) => entry.id === item.id,
                    );
                    if (!provider) return null;
                    return (
                      <ProviderTile
                        key={provider.id}
                        provider={provider}
                        groupLabel={group.label}
                        connection={
                          connections.find(
                            (row) =>
                              row.providerId === provider.id &&
                              row.status !== "revoked",
                          ) ?? null
                        }
                      />
                    );
                  })}
                </ul>
              </div>
            ))}
            {grouped.length === 0 ? (
              <div className="empty conn-marketplace-empty">
                <h3>No matching connectors</h3>
                <p>Try a provider name, category, or connector ID.</p>
                <EmptyTip>{emptyTips.keymap}</EmptyTip>
                <IconKey label="Clear search" small onClick={search.close}>
                  <IconX size={16} />
                </IconKey>
              </div>
            ) : null}
          </>
        )}
      </div>
      {search.query !== null ? (
        <SlashSearchField
          query={search.query}
          onChange={(value) => search.setQuery(value)}
          onClose={search.close}
          inputRef={search.inputRef}
          label="Search connectors"
        />
      ) : null}
    </section>
  );
}

function ProviderTile({
  provider,
  groupLabel,
  connection,
}: {
  provider: Provider;
  /** The heading the tile sits under, which its kind may only repeat. */
  groupLabel: string;
  connection: Connection | null;
}) {
  const note = catalogTileNote(provider, connection);
  // Under "Managed" every tile said "Managed", and "API Key" said "API key":
  // a kind is drawn only where it says something its heading and name do not.
  const kind = authKindLabel(provider);
  const repeats = [groupLabel, provider.displayName].some(
    (text) => text.toLowerCase() === kind.toLowerCase(),
  );
  const { hash } = useLocation();
  return (
    <li
      className={`conn-tile${hash === `#catalog-${encodeURIComponent(provider.id)}` ? " is-selected" : ""}`}
      id={`catalog-${encodeURIComponent(provider.id)}`}
    >
      <TileBody
        provider={provider}
        blocked={
          isVercelCatalogId(provider.id) && !isVercelConnectable(provider.id)
        }
      >
        <ConnectorMark
          providerId={provider.id}
          displayName={provider.displayName}
          size={32}
        />
        <span className="conn-tile__copy">
          <span className="conn-tile__name">{provider.displayName}</span>
          {repeats ? null : <span className="conn-tile__kind">{kind}</span>}
        </span>
        {note ? (
          <StatusMark tone={statusTone(note.tone)} label={note.label} />
        ) : null}
      </TileBody>
    </li>
  );
}

function TileBody({
  provider,
  blocked,
  children,
}: {
  provider: Provider;
  blocked: boolean;
  children: ReactNode;
}) {
  if (blocked) return <span className="conn-tile__link">{children}</span>;
  return (
    <Link
      className="conn-tile__link"
      tabIndex={-1}
      to={connectorPath(provider.id)}
    >
      {children}
      <IconChevronRight className="conn-tile__go" size={14} />
    </Link>
  );
}
