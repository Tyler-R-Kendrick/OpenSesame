import { useState } from "react";
import { Link } from "react-router";
import { IconInfo, IconSearch } from "../../components/Icons.js";
import type {
  Connection,
  Provider,
  ProviderCategory,
} from "../../lib/connections.js";
import { canConfigureAutomatically } from "../../lib/connector-guidance.js";
import {
  VERB_CHIP,
  VERB_LABEL,
  providerVerb,
} from "../../lib/identity-graph.js";
import { ConnectorMark } from "./ConnectorMark.js";
import { CATEGORY_LABELS, CATEGORY_ORDER, connectorPath } from "./shared.js";

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
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const catalogProviders = (providers ?? []).filter(
    (provider) => !canConfigureAutomatically(provider),
  );
  const visibleProviders = catalogProviders.filter((provider) =>
    `${provider.displayName} ${provider.id} ${CATEGORY_LABELS[provider.category]}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );

  const byCategory = new Map<ProviderCategory, Provider[]>();
  for (const provider of visibleProviders) {
    const list = byCategory.get(provider.category) ?? [];
    list.push(provider);
    byCategory.set(provider.category, list);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  const grouped = CATEGORY_ORDER.filter((category) =>
    byCategory.has(category),
  ).map((category) => ({
    category,
    items: byCategory.get(category) ?? [],
  }));

  const sealKeyMissing = (providers ?? []).some((provider) =>
    provider.missingConfig.some((name) => name.includes("CONNECTION_KEY")),
  );

  return (
    <section className="panel">
      <div className="panel__head conn-catalog__head">
        <h2>Add a connection</h2>
        <Link className="btn btn--sm" to="/connections/new">
          Custom connector
        </Link>
        <label className="conn-search">
          <span className="sr-only">Search connectors</span>
          <IconSearch size={16} />
          <input
            type="search"
            placeholder={`Search ${catalogProviders.length} connectors`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
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

            {grouped.map(({ category, items }) => (
              <div className="conn-group" key={category}>
                <h3 className="conn-group__label">
                  {CATEGORY_LABELS[category]}
                </h3>
                <ul className="conn-grid">
                  {items.map((provider) => (
                    <ProviderTile
                      key={provider.id}
                      provider={provider}
                      connection={
                        connections.find(
                          (item) =>
                            item.providerId === provider.id &&
                            item.status !== "revoked",
                        ) ?? null
                      }
                    />
                  ))}
                </ul>
              </div>
            ))}
            {visibleProviders.length === 0 ? (
              <div className="empty conn-marketplace-empty">
                <h3>No matching connectors</h3>
                <p>Try a provider name, category, or connector ID.</p>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setQuery("")}
                >
                  Clear search
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
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
  return (
    <li className="conn-tile">
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
