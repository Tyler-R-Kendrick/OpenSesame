import {
  connectPlan,
  isRefusedPlan,
} from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { isConnectionCatalogProvider } from "@opensesame/app-core/lib/connector-guidance.js";
import { isManagedConnector } from "@opensesame/app-core/lib/managed-connectors.js";
import { nativeBrowserMethodPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import {
  catalogTileNote,
  isVercelCatalogId,
  isVercelConnectable,
} from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { connectorPath } from "@opensesame/app-core/sections/connections/shared.js";
import { type ReactNode, useEffect } from "react";
import { Link, useLocation } from "react-router";
import { EmptyTip } from "../../components/EmptyTip.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconChevronRight, IconX } from "../../components/Icons.js";
import { useListingSearch } from "../../components/SlashSearch.js";
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

/** Catalog badges describe provider protocols; managed configuration is a mode. */
function browserProtocolLabel(
  providerId: string,
  method: "api-key" | "oauth",
  label: string,
): string {
  return nativeBrowserMethodPolicy(providerId, method).available
    ? label
    : `${label} (browser unavailable)`;
}

export function catalogMethodLabel(provider: Provider): string {
  const plan = connectPlan(provider.id);
  if (!plan) return authKindLabel(provider);
  const labels = plan.methods.flatMap((method) => {
    if (method.kind === "mcp") return ["MCP"];
    if (method.kind === "oauth" && method.preset)
      return [browserProtocolLabel(provider.id, "oauth", "OAuth")];
    if (method.kind === "api-key" && method.preset)
      return [browserProtocolLabel(provider.id, "api-key", "API key")];
    return [];
  });
  return [...new Set(labels)].join(" · ") || "Configuration";
}

/** Enter in the prompt lands on the first tile, when the search left one. */
function focusFirstTile(): boolean {
  const tile = document.querySelector<HTMLElement>(
    "#catalog .conn-tile a, #catalog .conn-tile button",
  );
  tile?.focus();
  return tile !== null && document.activeElement === tile;
}

/** The connector catalog: search, category groups, brand-marked tiles. */
export function CatalogPanel({
  providers,
  connections = [],
}: {
  providers: Provider[] | null;
  connections?: Connection[];
}) {
  const search = useListingSearch(focusFirstTile);
  const { hash } = useLocation();
  useEffect(() => {
    if (hash.startsWith("#catalog-")) search.close();
  }, [hash, search.close]);
  const panelRef = useGuideTarget<HTMLElement>("connections.catalog");
  // The catalog is searched in the status-line prompt, so the guide points
  // at that field while this panel is on screen.
  const pickerRef = useGuideTarget<HTMLElement>("connections.provider-picker");
  useEffect(() => {
    pickerRef(document.getElementById("command-bar-input"));
    return () => pickerRef(null);
  }, [pickerRef]);
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
      </div>

      <div className="panel__body">
        {providers === null ? (
          <p className="hint">Loading the connector catalog…</p>
        ) : (
          <>
            <FailureNotice
              id="connections:sealing"
              title="Connection sealing"
              tone="warn"
              message={
                sealKeyMissing
                  ? "Connection sealing is not available yet on this deployment. Ask an operator to finish setup, then try again."
                  : null
              }
            />

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
                <EmptyTip tip="keymap" />
                <IconKey label="Clear search" small onClick={search.close}>
                  <IconX size={16} />
                </IconKey>
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
  const kind = catalogMethodLabel(provider);
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
          isRefusedPlan(provider.id) ||
          (isVercelCatalogId(provider.id) && !isVercelConnectable(provider.id))
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
