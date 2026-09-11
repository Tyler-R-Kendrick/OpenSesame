import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import {
  SlashSearchField,
  SlashSearchKey,
  useListingSearch,
} from "../../components/SlashSearch.js";
import { IconInfo } from "../../components/Icons.js";
import type { Connection, Provider } from "../../lib/connections.js";
import { canConfigureAutomatically } from "../../lib/connector-guidance.js";
import {
  VERB_CHIP,
  VERB_LABEL,
  providerVerb,
} from "../../lib/identity-graph.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ConnectorMark } from "./ConnectorMark.js";
import { catalogPageSections } from "./page-tree.js";
import { connectorPath } from "./shared.js";

export function authKindLabel(provider: Provider): string {
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
    (provider) => !canConfigureAutomatically(provider),
  );
  const grouped = catalogPageSections(providers ?? [], normalizedQuery);

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
          <Link ref={customRef} className="btn btn--sm" to="/connections/new">
            Custom connector
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
                This Host is missing <code>OPENSESAME_CONNECTION_KEY</code>, so
                credentials cannot be sealed yet. Set it and restart the Host.
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
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={search.close}
                >
                  Clear search
                </button>
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
  connection,
}: {
  provider: Provider;
  connection: Connection | null;
}) {
  const verb = providerVerb(provider, connection);
  const { hash } = useLocation();
  return (
    <li
      className={`conn-tile${hash === `#catalog-${encodeURIComponent(provider.id)}` ? " is-selected" : ""}`}
      id={`catalog-${encodeURIComponent(provider.id)}`}
    >
      <Link className="conn-tile__link" to={connectorPath(provider.id)}>
        <ConnectorMark
          providerId={provider.id}
          displayName={provider.displayName}
          size={32}
        />
        <span className="conn-tile__copy">
          <span className="conn-tile__name">{provider.displayName}</span>
          <span className="conn-tile__kind">{authKindLabel(provider)}</span>
        </span>
        {verb !== "idle" ? (
          <span className={`chip chip--sm-tile ${VERB_CHIP[verb]}`}>
            {VERB_LABEL[verb]}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
