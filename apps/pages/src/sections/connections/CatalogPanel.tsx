import { modelProtocolLabel } from "@opensesame/app-core/lib/ai-model-provider.js";
import { UNAVAILABLE_LABEL } from "@opensesame/app-core/lib/browser-disposition.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import type { ConnectorCardAction } from "@opensesame/app-core/lib/connector-action-capability.js";
import { isManagedConnector } from "@opensesame/app-core/lib/managed-connectors.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { catalogTileNote } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { connectorPath } from "@opensesame/app-core/sections/connections/shared.js";
import { type ReactNode, useEffect } from "react";
import { Link, useLocation } from "react-router";
import { EmptyTip } from "../../components/EmptyTip.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconArrowRight,
  IconLock,
  IconMonitor,
  IconPlus,
  IconX,
} from "../../components/Icons.js";
import { useListingSearch } from "../../components/SlashSearch.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ConnectorMark } from "./ConnectorMark.js";
import { InstalledConnectorActions } from "./InstalledConnectorActions.js";
import {
  catalogConnectorAction,
  preferredCatalogConnection,
} from "./catalog-connector-action.js";
import {
  catalogAuthMethods,
  curatedCatalogProviders,
  matchesCatalog,
} from "./catalog-selection.js";
import { identityConnectionMethodLabel } from "./identity/identity-ui-values.js";

export function authKindLabel(provider: Provider): string {
  if (isManagedConnector(provider.id)) return "Managed";
  if (provider.id === "openrouter") return "Delegated sign-in";
  if (provider.authKind === "api_key") return "API key";
  if (provider.authKind === "configuration") return "Configuration";
  return "OAuth";
}

/** A model provider's tile also says which API it speaks (ADR 0192). */
function withModelProtocol(provider: Provider, label: string): string {
  const protocol =
    provider.category === "ai_model_provider"
      ? modelProtocolLabel(provider.id)
      : null;
  return protocol ? `${label} · ${protocol}` : label;
}

export function catalogMethodLabel(provider: Provider): string {
  const identity = identityConnectionMethodLabel(provider.id);
  if (identity) return identity;
  const plan = connectPlan(provider.id);
  if (!plan) return withModelProtocol(provider, authKindLabel(provider));
  const labels = plan.methods.flatMap((method) => {
    if (method.kind === "mcp") return ["MCP"];
    if (method.kind === "oauth" && method.preset) return ["OAuth"];
    if (method.kind === "api-key" && method.preset) return ["API key"];
    return [];
  });
  return withModelProtocol(
    provider,
    [...new Set(labels)].join(" · ") || "Configuration",
  );
}

/** Enter in the prompt lands on the first tile, when the search left one. */
function focusFirstTile(): boolean {
  const tile = document.querySelector<HTMLElement>(
    "#catalog .conn-tile summary, #catalog .conn-tile a, #catalog .conn-tile button",
  );
  tile?.focus();
  return tile !== null && document.activeElement === tile;
}

/** The connector catalog: one searchable list, brand-marked tiles. */
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
  const catalogProviders = curatedCatalogProviders(providers ?? [], {
    includeFeatured: true,
    includeFamilies: true,
  }).filter((provider) => matchesCatalog(provider, normalizedQuery));

  const sealKeyMissing = (providers ?? []).some((provider) =>
    provider.missingConfig.some((name) => name.includes("CONNECTION_KEY")),
  );

  return (
    <section id="catalog" className="panel" ref={panelRef}>
      <div className="panel__head conn-catalog__head">
        <h2>Add a connection</h2>
        <Link
          id="catalog-add"
          className="icon-btn icon-btn--sm"
          aria-label="Add a custom connection"
          title="Add a custom connection"
          to="/connections/custom-oidc"
        >
          <IconPlus size={16} />
        </Link>
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

            <ul className="conn-grid">
              {catalogProviders.map((provider) => (
                <ProviderTile
                  key={provider.id}
                  provider={provider}
                  methods={catalogAuthMethods(provider)}
                  connection={preferredCatalogConnection(provider, connections)}
                />
              ))}
            </ul>
            {catalogProviders.length === 0 ? (
              <div className="empty conn-marketplace-empty">
                <h3>No matching connectors</h3>
                <p>Try a provider name, tag, or connector ID.</p>
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
  methods,
  connection,
}: {
  provider: Provider;
  methods: readonly string[];
  connection: Connection | null;
}) {
  const action = catalogConnectorAction(provider, connection);
  const note =
    action.kind === "configure" || action.kind === "resume"
      ? catalogTileNote(
          provider,
          connection,
          connection
            ? readNativeConnector(connection.connectionId)?.configuration.method
            : undefined,
        )
      : null;
  const kind = catalogMethodLabel(provider);
  const repeats =
    provider.displayName.toLowerCase() === kind.toLowerCase() ||
    methods.some((method) => method.toLowerCase() === kind.toLowerCase());
  const tagsId = `catalog-${encodeURIComponent(provider.id)}-tags`;
  const { hash } = useLocation();
  return (
    <li
      className={`conn-tile${hash === `#catalog-${encodeURIComponent(provider.id)}` ? " is-selected" : ""}`}
      id={`catalog-${encodeURIComponent(provider.id)}`}
    >
      <TileBody provider={provider} action={action} describedBy={tagsId}>
        <ConnectorMark
          providerId={provider.id}
          displayName={provider.displayName}
          size={32}
        />
        <span className="conn-tile__copy">
          <span className="conn-tile__name">{provider.displayName}</span>
          {repeats ? null : <span className="conn-tile__kind">{kind}</span>}
          <span className="conn-tile__tags" id={tagsId}>
            {methods.map((method) => (
              <span className="conn-tag conn-tag--method" key={method}>
                {method}
              </span>
            ))}
          </span>
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
  action,
  describedBy,
  children,
}: {
  provider: Provider;
  action: ConnectorCardAction;
  describedBy?: string;
  children: ReactNode;
}) {
  if (action.kind === "configure")
    return (
      <InstalledConnectorActions
        provider={provider}
        connectionId={action.connectionId}
        describedBy={describedBy}
      >
        {children}
      </InstalledConnectorActions>
    );
  if (action.kind === "native" || action.kind === "unavailable") {
    const label = action.reason
      ? UNAVAILABLE_LABEL[action.reason]
      : action.kind === "native"
        ? "Desktop app required"
        : "Unavailable";
    const face = (
      <>
        {children}
        {action.kind === "native" ? (
          <IconMonitor className="conn-tile__go" size={18} title={label} />
        ) : (
          <IconLock className="conn-tile__go" size={18} title={label} />
        )}
      </>
    );
    return action.kind === "native" && action.install ? (
      <a
        className="conn-tile__link"
        tabIndex={-1}
        href={action.install.href}
        aria-label={action.install.label}
        aria-describedby={describedBy}
      >
        {face}
      </a>
    ) : (
      <span className="conn-tile__link" title={label}>
        {face}
      </span>
    );
  }
  return (
    <Link
      className="conn-tile__link"
      tabIndex={-1}
      aria-label={`${action.kind === "resume" ? "Resume sign-in to" : "Connect"} ${provider.displayName}`}
      aria-describedby={describedBy}
      to={connectorPath(
        provider.id,
        action.kind === "resume" ? action.connectionId : undefined,
      )}
    >
      {children}
      {action.kind === "resume" ? (
        <IconArrowRight className="conn-tile__go" size={18} />
      ) : (
        <IconPlus className="conn-tile__go" size={18} />
      )}
    </Link>
  );
}
