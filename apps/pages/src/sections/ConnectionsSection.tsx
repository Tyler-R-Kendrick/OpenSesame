import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router";
import {
  IconAlert,
  IconCheck,
  IconChevronLeft,
  IconClock,
  IconConnection,
  IconInfo,
  IconLock,
  IconLogin,
  IconPasskey,
  IconRefresh,
  IconSearch,
  IconSecret,
  IconSettings,
  IconX,
} from "../components/Icons.js";
import { PagesCannotHostNote } from "../components/PagesCannotHostNote.js";
import {
  type Connection,
  ConnectionsError,
  type Provider,
  type ProviderCategory,
  authorizeConnection,
  awaitConsent,
  bindConnection,
  createConnection,
  discoverConnections,
  listConnections,
  listProviders,
  openConsentPopup,
  revokeConnection,
} from "../lib/connections.js";
import {
  canConfigureAutomatically,
  connectorSummary,
} from "../lib/connector-guidance.js";
import {
  getBundledProviders,
  readEmbeddedProviders,
  writeEmbeddedProviders,
} from "../lib/embedded-catalog.js";
import {
  VERB_CHIP,
  VERB_LABEL,
  addPipe,
  buildConnectorReminder,
  connectionVerb,
  dismissFirstRun,
  firstRunDismissed,
  firstRunProviders,
  grantReminderToAgent,
  grantableAgentId,
  graphDoors,
  hasConnectorReminder,
  providerVerb,
  unfinishedConnections,
  vaultCreateHref,
} from "../lib/identity-graph.js";
import {
  HostSessionError,
  ensureHostSession,
  hostBase,
  hostLocalSessionEligible,
  useConnect,
  useIdentitySession,
} from "../lib/identity.js";
import { shouldAutoConnect } from "../lib/settings.js";
import { useOnline } from "../lib/use-online.js";
import { useStatusNotice } from "../lib/use-status-notice.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { ActivityLog } from "./connections/ActivityLog.js";
import { BindingEditor } from "./connections/BindingEditor.js";
import { ConnectForm } from "./connections/ConnectForm.js";
import { ConnectionCard } from "./connections/ConnectionCard.js";
import { PolicyEditor } from "./connections/PolicyEditor.js";
import { DeploymentSetupGuide } from "./connections/guides.js";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type Flash,
  type LoadFailure,
  STATUS_CHIP,
  connectorPath,
  errorText,
  statusSentence,
} from "./connections/shared.js";
import "./connections.css";

/* ============================================================== the section */

export function ConnectionsSection() {
  const { providerId, connectionId } = useParams();
  const online = useOnline();
  const base = hostBase();
  const session = useIdentitySession();
  const { connecting, error: connectError, connect } = useConnect();

  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [catalogError, setCatalogError] = useState<LoadFailure | null>(null);
  const [loadError, setLoadError] = useState<LoadFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [rememberOffer, setRememberOffer] = useState<{
    provider: Provider;
    connection: Connection;
  } | null>(null);

  const catalogRun = useRef(0);
  const connectionRun = useRef(0);

  const loadCatalog = useCallback(async () => {
    const id = ++catalogRun.current;
    // Never leave the gallery blocked on Turso/OPFS — paint the bundle first.
    setProviders(getBundledProviders());
    const embedded = await readEmbeddedProviders();
    if (catalogRun.current !== id) return;
    setProviders(embedded);
    try {
      const nextProviders = await listProviders();
      if (catalogRun.current !== id) return;
      if (nextProviders.length === 0) {
        // An empty Host catalog must not wipe the built-in list on github.io.
        setCatalogError(null);
        return;
      }
      setProviders(nextProviders);
      setCatalogError(null);
      void writeEmbeddedProviders(nextProviders);
    } catch (error) {
      if (catalogRun.current !== id) return;
      setCatalogError({
        message: errorText(error),
        unreachable:
          error instanceof ConnectionsError && error.code === "unreachable",
      });
    }
  }, []);

  const loadConnections = useCallback(async () => {
    const id = ++connectionRun.current;
    setLoading(true);
    try {
      let configured = 0;
      try {
        configured = await discoverConnections();
      } catch {
        // Discovery is best-effort — never block the connections list on it.
      }
      const nextConnections = await listConnections();
      if (connectionRun.current !== id) return;
      setConnections(nextConnections);
      setLoadError(null);
      if (configured > 0) {
        setFlash({
          tone: "ok",
          text: `${configured} connector${configured === 1 ? "" : "s"} already configured on this Host ${configured === 1 ? "was" : "were"} connected automatically.`,
        });
      }
    } catch (error) {
      if (connectionRun.current !== id) return;
      setConnections(null);
      setLoadError({
        message: errorText(error),
        unreachable:
          error instanceof ConnectionsError && error.code === "unreachable",
        setupRequired:
          error instanceof HostSessionError && error.code !== "invalid_host",
      });
    } finally {
      if (connectionRun.current === id) setLoading(false);
    }
  }, []);

  // Re-run after Identity changes because Host authentication is session-backed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: session is the retry trigger.
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog, session]);

  useEffect(() => {
    if (!session && !hostLocalSessionEligible()) return;
    void loadConnections();
  }, [session, loadConnections]);

  useEffect(() => {
    if (hostLocalSessionEligible()) return;
    if (session || !online || connecting || connectError) return;
    if (!shouldAutoConnect()) return;
    void connect();
  }, [session, online, connecting, connectError, connect]);

  // Standing load trouble goes to the notifications tray, not the page.
  useStatusNotice(
    loadError && !loadError.setupRequired
      ? {
          id: "connections-load",
          tone: "err",
          title: loadError.unreachable
            ? "Host API unavailable"
            : "Connections could not load",
          body: `${loadError.message} ${
            loadError.unreachable
              ? "Start the configured Host service, or repair it here."
              : "Try refreshing the connection list."
          }`,
          ...(loadError.unreachable
            ? {
                ceremony: "host" as const,
                ceremonyLabel: "Repair the Host connection",
              }
            : null),
          retry: loadConnections,
          retryLabel: "Reload",
        }
      : null,
  );
  useStatusNotice(
    catalogError && (providers?.length ?? 0) > 0
      ? {
          id: "catalog-stale",
          tone: "warn",
          title: "Host catalog did not refresh",
          body: "Showing the bundled connectors instead.",
          retry: loadCatalog,
          retryLabel: "Try again",
        }
      : null,
  );

  if (providerId) {
    const provider = providers?.find((item) => item.id === providerId) ?? null;
    const providerConnections = (connections ?? []).filter(
      (item) => item.providerId === providerId && item.status !== "revoked",
    );
    const connection = connectionId
      ? (providerConnections.find(
          (item) => item.connectionId === connectionId,
        ) ?? null)
      : providerConnections.length === 1
        ? (providerConnections[0] ?? null)
        : null;
    return (
      <ConnectorSettingsPage
        provider={provider}
        providerId={providerId}
        connection={connection}
        connections={providerConnections}
        loading={
          providers === null || (session !== null && connections === null)
        }
        online={online}
        canConfigure={
          (session !== null || hostLocalSessionEligible()) &&
          loadError?.setupRequired !== true
        }
        configureHint={
          session === null
            ? "Host authorization waits on an Identity session. You can still save a vault login or import one below."
            : "Select an organization before configuring this connector."
        }
        flash={flash}
        rememberOffer={rememberOffer}
        onFlash={setFlash}
        onRememberOffer={setRememberOffer}
        onChanged={() => void loadConnections()}
      />
    );
  }

  return (
    <div className="section__inner">
      <ConnectionsHead base={base} />
      <PagesCannotHostNote ceremony="Host authorization" />
      <IdentitySessionNote />

      {flash ? (
        <output className={`note note--${flash.tone} conn-flash`}>
          {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
          <p>{flash.text}</p>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setFlash(null)}
            aria-label="Dismiss"
          >
            <IconX />
          </button>
        </output>
      ) : null}

      {online ? null : (
        <p className="note note--warn">
          <IconAlert /> This browser is offline. Nothing on this page can be
          read or changed until it reconnects.
        </p>
      )}

      {catalogError && (providers?.length ?? 0) === 0 ? (
        <CatalogError failure={catalogError} onRetry={loadCatalog} />
      ) : null}

      <UnfinishedInbox
        connections={connections ?? []}
        providers={providers ?? []}
        onFlash={setFlash}
        onChanged={() => void loadConnections()}
      />

      <FirstRunThree
        providers={providers ?? []}
        connections={connections ?? []}
      />

      {rememberOffer ? (
        <VaultReminderBanner
          offer={rememberOffer}
          onFlash={setFlash}
          onDismiss={() => setRememberOffer(null)}
        />
      ) : null}

      <ConnectionsPanel
        connections={connections}
        providers={providers ?? []}
        loading={loading}
        online={online}
        onReload={() => void loadConnections()}
        onFlash={setFlash}
        onRememberOffer={setRememberOffer}
        setupRequired={loadError?.setupRequired === true}
      />

      <PipeDiagram />

      <GalleryPanel providers={providers} connections={connections ?? []} />
    </div>
  );
}

function ConnectorSettingsPage({
  provider,
  providerId,
  connection,
  connections,
  loading,
  online,
  canConfigure,
  configureHint,
  flash,
  rememberOffer,
  onFlash,
  onRememberOffer,
  onChanged,
}: {
  provider: Provider | null;
  providerId: string;
  connection: Connection | null;
  connections: Connection[];
  loading: boolean;
  online: boolean;
  canConfigure: boolean;
  configureHint: string;
  flash: Flash | null;
  rememberOffer: { provider: Provider; connection: Connection } | null;
  onFlash: (flash: Flash | null) => void;
  onRememberOffer: (
    offer: { provider: Provider; connection: Connection } | null,
  ) => void;
  onChanged: () => void;
}) {
  if (!provider) {
    return (
      <div className="section__inner">
        <Link className="conn-back" to="/connections">
          <IconChevronLeft size={16} /> All connections
        </Link>
        <div className="panel">
          <div className="empty">
            <IconConnection />
            <h1>
              {loading ? "Loading connector settings…" : "Connector not found"}
            </h1>
            <p>
              {loading
                ? "Reading this connector from the Host."
                : `No connector named ${providerId} is in the active catalog.`}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const automatic = canConfigureAutomatically(provider);
  return (
    <div className="section__inner conn-settings">
      <Link className="conn-back" to="/connections">
        <IconChevronLeft size={16} /> All connections
      </Link>
      <PagesCannotHostNote ceremony="Host authorization" />
      <IdentitySessionNote />
      <header className="conn-settings__head">
        <div>
          <h1>{provider.displayName}</h1>
          <p>{connectorSummary(provider)}</p>
        </div>
        <span
          className={`chip ${
            VERB_CHIP[
              connections.length > 1 && !connection
                ? "idle"
                : providerVerb(provider, connection)
            ]
          }`}
          aria-label={`Connector status: ${
            connection
              ? VERB_LABEL[connectionVerb(connection.status)]
              : connections.length > 1
                ? `${connections.length} authorizations`
                : VERB_LABEL[providerVerb(provider, null)]
          }`}
        >
          {connection
            ? VERB_LABEL[connectionVerb(connection.status)]
            : connections.length > 1
              ? `${connections.length} authorizations`
              : VERB_LABEL[providerVerb(provider, null)]}
        </span>
      </header>

      {flash ? (
        <output className={`note note--${flash.tone} conn-flash`}>
          {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
          <p>{flash.text}</p>
          <button
            type="button"
            className="icon-btn"
            onClick={() => onFlash(null)}
            aria-label="Dismiss"
          >
            <IconX />
          </button>
        </output>
      ) : null}

      {rememberOffer ? (
        <VaultReminderBanner
          offer={rememberOffer}
          onFlash={onFlash}
          onDismiss={() => onRememberOffer(null)}
        />
      ) : null}

      {connection ? (
        <nav className="conn-settings__nav" aria-label="Connector settings">
          <Link to="#identity">This identity</Link>
          <Link to="#authorization">Authorization</Link>
          <Link to="#access">Who can use it</Link>
          <Link to="#rules">Rules</Link>
        </nav>
      ) : null}

      <IdentityGraphPanel
        provider={provider}
        connections={connections}
        connection={connection}
        onFlash={onFlash}
        onChanged={onChanged}
      />

      <AddSecretChooser provider={provider} connection={connection} />

      {automatic ? (
        <section className="panel" id="authorization">
          <div className="panel__head">
            <div>
              <h2>Authorization</h2>
              <p>No account sign-in or additional configuration is required.</p>
            </div>
          </div>
          <ul className="conn-list">
            <AutomaticService
              provider={provider}
              connection={connection}
              online={online}
              onFlash={(next) => onFlash(next)}
              onChanged={onChanged}
              onRememberOffer={(offer) => onRememberOffer(offer)}
              settings={false}
            />
          </ul>
        </section>
      ) : connection ? (
        <section className="panel" id="authorization">
          <div className="panel__head">
            <div>
              <h2>Authorization</h2>
              <p>Credential lifecycle, provider scope, and renewal status.</p>
            </div>
          </div>
          <ul className="conn-list">
            <ConnectionCard
              connection={connection}
              provider={provider}
              online={online}
              onFlash={(next) => onFlash(next)}
              onChanged={onChanged}
              showBindings={false}
            />
          </ul>
        </section>
      ) : connections.length > 1 ? (
        <section className="panel" id="authorization">
          <div className="panel__head">
            <div>
              <h2>Authorizations</h2>
              <p>Choose the account whose access and rules you want to edit.</p>
            </div>
          </div>
          <ul className="conn-list">
            {connections.map((item) => (
              <AuthorizedConnection
                key={item.connectionId}
                connection={item}
                provider={provider}
              />
            ))}
          </ul>
          {canConfigure && provider.configured ? (
            <details className="conn-add-authorization">
              <summary>Add another authorization</summary>
              <ConnectForm
                provider={provider}
                online={online}
                onFlash={(next) => onFlash(next)}
                onConnected={onChanged}
                onRememberOffer={(connection) =>
                  onRememberOffer({ provider, connection })
                }
              />
            </details>
          ) : null}
        </section>
      ) : (
        <section className="panel" id="authorization">
          <div className="panel__head">
            <div>
              <h2>Authorization</h2>
              <p>Create a separate authorization for this connector.</p>
            </div>
          </div>
          {!canConfigure ? (
            <div className="panel__body">
              <p className="hint">{configureHint}</p>
            </div>
          ) : provider.configured ||
            provider.id === "github" ||
            provider.id === "gitlab" ? (
            <ConnectForm
              provider={provider}
              online={online}
              onFlash={(next) => onFlash(next)}
              onConnected={onChanged}
              onRememberOffer={(created) =>
                onRememberOffer({ provider, connection: created })
              }
            />
          ) : (
            <div className="panel__body">
              <DeploymentSetupGuide provider={provider} />
            </div>
          )}
        </section>
      )}

      {connection ? (
        <>
          <section className="panel" id="access">
            <div className="panel__head">
              <div>
                <h2>Who can use it</h2>
                <p>
                  Assign this authorization to identities, groups, devices,
                  projects, or agents.
                </p>
              </div>
            </div>
            <div className="panel__body">
              <BindingEditor
                connection={connection}
                online={online}
                onFlash={(next) => onFlash(next)}
                onChanged={onChanged}
              />
            </div>
          </section>
          <section className="panel" id="rules">
            <div className="panel__head">
              <div>
                <h2>Rules</h2>
                <p>
                  Set how broadly this authorization may be delegated and
                  invoked.
                </p>
              </div>
            </div>
            <div className="panel__body">
              <PolicyEditor
                connection={connection}
                online={online}
                onFlash={(next) => onFlash(next)}
                onChanged={onChanged}
              />
            </div>
          </section>
        </>
      ) : (
        <section className="panel">
          <div className="empty conn-policy-empty">
            <IconLock />
            <h2>
              {connections.length > 1
                ? "Choose an authorization"
                : "Access and rules follow authorization"}
            </h2>
            <p>
              {connections.length > 1
                ? "Open one above to edit exactly who can use it and how."
                : "Enable this connector first, then choose exactly who can use it and how."}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

function CatalogError({
  failure,
  onRetry,
}: {
  failure: LoadFailure;
  onRetry: () => void;
}) {
  return (
    <div className="note note--err conn-error" role="alert">
      <IconAlert />
      <div className="conn-error__copy">
        <strong>Built-in connector catalog unavailable</strong>
        <p>{failure.message}</p>
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          Try catalog again
        </button>
      </div>
    </div>
  );
}

function ConnectionsHead({ base }: { base: string }) {
  return (
    <header className="section__head">
      <h1>Connections</h1>
      <p>
        Authorize a service once, then hand it to the projects and agents that
        need it. Unlike the vault, the authority plane at <code>{base}</code>{" "}
        can read these credentials — it has to, in order to renew them while you
        are away and to attach them at the edge of an outbound request. It never
        hands one back: nothing on this page, and no agent, ever sees the token
        itself.
      </p>
    </header>
  );
}

function IdentitySessionNote() {
  const session = useIdentitySession();
  const { connecting, error, connect } = useConnect();
  const relevant =
    !hostLocalSessionEligible() &&
    !session &&
    (shouldAutoConnect() || connecting || Boolean(error));
  useStatusNotice(
    relevant
      ? error
        ? {
            id: "identity-session",
            tone: "err",
            title: "OpenSesame Identity is unreachable",
            body: `Host connectors cannot authorize yet. Vault logins, passkeys, and import still work on this device. ${error}`,
            retry: connect,
            retryLabel: "Try Identity again",
          }
        : {
            id: "identity-session",
            tone: "info",
            title: "Starting your OpenSesame session",
            body: "Host connectors can authorize once the session is up. Vault items on this identity stay available either way.",
          }
      : null,
  );
  return null;
}

/* ======================================================= authorized services */

function ConnectionsPanel({
  connections,
  providers,
  loading,
  online,
  onReload,
  onFlash,
  onRememberOffer,
  setupRequired,
}: {
  connections: Connection[] | null;
  providers: Provider[];
  loading: boolean;
  online: boolean;
  onReload: () => void;
  onFlash: (flash: Flash) => void;
  onRememberOffer: (offer: {
    provider: Provider;
    connection: Connection;
  }) => void;
  setupRequired: boolean;
}) {
  const live = (connections ?? []).filter((c) => c.status !== "revoked");
  const automatic = providers.filter(canConfigureAutomatically);
  const automaticIds = new Set(automatic.map((provider) => provider.id));
  const managed = (connections ?? []).filter(
    (connection) =>
      connection.status !== "revoked" &&
      !automaticIds.has(connection.providerId),
  );

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Authorized services</h2>
          <p>
            What this deployment can act on, who it is acting as, and which
            identities are allowed to use it.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={onReload}
          disabled={loading || !online}
        >
          <IconRefresh size={16} />
          {loading ? "Loading…" : "Reload"}
        </button>
      </div>

      <div className="panel__body panel__body--tight">
        {setupRequired ? (
          <div className="empty conn-gate">
            <span className="empty__mark">
              <IconLock />
            </span>
            <h3>Choose an organization to manage connections</h3>
            <p>
              The marketplace is ready below. Creating and managing private
              connections starts after Identity and the Host agree on your
              organization.
            </p>
          </div>
        ) : connections === null ? (
          <div className="conn-pad">
            <p className="hint">
              {loading
                ? "Reading connections…"
                : "Connections could not be read."}
            </p>
          </div>
        ) : automatic.length === 0 && managed.length === 0 ? (
          <div className="empty">
            <span className="empty__mark">
              <IconConnection />
            </span>
            <h3>No services authorized yet</h3>
            <p>
              Pick one below. You approve it once, and every project or agent
              you bind it to uses that same authorization — none of them get a
              copy of the credential.
            </p>
          </div>
        ) : (
          <ul className="conn-list">
            {automatic.map((provider) => (
              <AutomaticService
                key={provider.id}
                provider={provider}
                connection={
                  live.find(
                    (connection) => connection.providerId === provider.id,
                  ) ?? null
                }
                online={online}
                onFlash={onFlash}
                onChanged={onReload}
                onRememberOffer={onRememberOffer}
              />
            ))}
            {managed.map((connection) => (
              <AuthorizedConnection
                key={connection.connectionId}
                connection={connection}
                provider={
                  providers.find((p) => p.id === connection.providerId) ?? null
                }
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AuthorizedConnection({
  connection,
  provider,
}: {
  connection: Connection;
  provider: Provider | null;
}) {
  const chip = STATUS_CHIP[connection.status];
  return (
    <li className="conn-service">
      <div>
        <h3>{connection.displayName}</h3>
        <p>{statusSentence(connection, provider)}</p>
      </div>
      <div className="conn-service__actions">
        <span className={`chip ${chip.tone}`}>{chip.label}</span>
        <Link
          className="btn btn--sm"
          to={connectorPath(connection.providerId, connection.connectionId)}
          aria-label={`Settings for ${connection.displayName}`}
        >
          <IconSettings size={16} /> Settings
        </Link>
      </div>
    </li>
  );
}

function AutomaticService({
  provider,
  connection,
  online,
  onFlash,
  onChanged,
  onRememberOffer,
  settings = true,
}: {
  provider: Provider;
  connection: Connection | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  onRememberOffer?: (offer: {
    provider: Provider;
    connection: Connection;
  }) => void;
  settings?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const enabled = connection !== null;

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      if (next) {
        const created = await createConnection({
          providerId: provider.id,
          displayName: provider.displayName,
        });
        onRememberOffer?.({ provider, connection: created });
      } else if (connection) {
        await revokeConnection(connection.connectionId);
      }
      onFlash({
        tone: "ok",
        text: `${provider.displayName} is ${next ? "enabled" : "disabled"}.`,
      });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="conn-service">
      <div>
        <h3>{provider.displayName}</h3>
        <p>
          {provider.id === "sealed-local"
            ? "Encrypted local storage with a Host-generated sealing key."
            : provider.id === "plain"
              ? "Built-in local plaintext storage for non-sensitive values."
              : "Detected from this Host and ready without additional setup."}
        </p>
      </div>
      <div className="conn-service__actions">
        {settings ? (
          <Link
            className="btn btn--sm"
            to={connectorPath(provider.id, connection?.connectionId)}
            aria-label={`Settings for ${provider.displayName}`}
          >
            <IconSettings size={16} /> Settings
          </Link>
        ) : null}
        <label className="conn-switch">
          <span>{enabled ? "Enabled" : "Disabled"}</span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            checked={enabled}
            disabled={busy || !online || !provider.configured}
            onChange={(event) => void toggle(event.target.checked)}
            aria-label={`${enabled ? "Disable" : "Enable"} ${provider.displayName}`}
          />
          <span className="conn-switch__track" aria-hidden="true" />
        </label>
      </div>
    </li>
  );
}

/* =================================================== identity graph / inbox */

function UnfinishedInbox({
  connections,
  providers,
  onFlash,
  onChanged,
}: {
  connections: Connection[];
  providers: Provider[];
  onFlash: (flash: Flash | null) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const open = unfinishedConnections(connections);
  if (open.length === 0) return null;

  // A panel headed "Needs you" used to answer with a link to another route —
  // the exact failure the ceremony rule exists to prevent. Finishing an
  // authorization is the same consent round trip the connection row already
  // runs, so it runs here, where the problem was reported.
  async function finish(connection: Connection) {
    const popup = openConsentPopup("about:blank");
    setBusy(connection.connectionId);
    try {
      await ensureHostSession();
      const { authorizationUrl } = await authorizeConnection(
        connection.connectionId,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;
      const outcome = await awaitConsent(connection.connectionId, popup);
      if (outcome.result === "active") {
        onFlash({
          tone: "ok",
          text: `${connection.displayName} is authorized.`,
        });
      } else if (outcome.result === "failed") {
        onFlash({
          tone: "err",
          text:
            outcome.connection.statusDetail ??
            "The provider refused the authorization.",
        });
      } else {
        onFlash({ tone: "warn", text: "Authorization was not completed." });
      }
      onChanged();
    } catch (error) {
      popup?.close();
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="conn-inbox-title">
      <div className="panel__head">
        <div>
          <h2 id="conn-inbox-title">Needs you</h2>
          <p>
            Authorization started but is not usable yet. These do not expire
            from this list until you finish or revoke them.
          </p>
        </div>
      </div>
      <ul className="conn-list">
        {open.map((connection) => {
          const provider =
            providers.find((item) => item.id === connection.providerId) ?? null;
          const verb = connectionVerb(connection.status);
          return (
            <li key={connection.connectionId} className="conn-service">
              <div>
                <h3>{connection.displayName}</h3>
                <p>{statusSentence(connection, provider)}</p>
              </div>
              <div className="conn-service__actions">
                <span className={`chip ${VERB_CHIP[verb]}`}>
                  {VERB_LABEL[verb]}
                </span>
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={busy !== null}
                  aria-busy={busy === connection.connectionId}
                  onClick={() => void finish(connection)}
                >
                  {busy === connection.connectionId
                    ? "Authorizing…"
                    : "Finish authorization"}
                </button>
                <Link
                  className="btn btn--sm btn--ghost"
                  to={connectorPath(
                    connection.providerId,
                    connection.connectionId,
                  )}
                >
                  Details
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function VaultReminderBanner({
  offer,
  onFlash,
  onDismiss,
}: {
  offer: { provider: Provider; connection: Connection };
  onFlash: (flash: Flash | null) => void;
  onDismiss: () => void;
}) {
  const { items } = useVault();
  const store = useVaultStore();
  const [busy, setBusy] = useState(false);
  if (hasConnectorReminder(items, offer.connection)) return null;

  async function save() {
    setBusy(true);
    try {
      await store.addItems([
        buildConnectorReminder(offer.provider, offer.connection),
      ]);
      onFlash({
        tone: "ok",
        text: `Saved to Host. Added a vault reminder for ${offer.provider.displayName}. The credential itself stays on the Host.`,
      });
      onDismiss();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <output className="note note--ok conn-flash">
      <IconCheck />
      <p>
        Saved {offer.provider.displayName} on this Host. Add a vault reminder
        that points at the ConnectionRef — not the token?
      </p>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={busy}
        onClick={() => void save()}
      >
        Remember in vault
      </button>
      <button type="button" className="btn btn--sm" onClick={onDismiss}>
        Not now
      </button>
    </output>
  );
}

function FirstRunThree({
  providers,
  connections,
}: {
  providers: Provider[];
  connections: Connection[];
}) {
  const [hidden, setHidden] = useState(firstRunDismissed);
  if (hidden) return null;
  const picks = firstRunProviders(providers);
  if (picks.length === 0) return null;
  const active = new Set(
    connections
      .filter((connection) => connection.status === "active")
      .map((connection) => connection.providerId),
  );
  if (picks.every((provider) => active.has(provider.id))) return null;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Connect the three you use daily</h2>
          <p>
            Authorize once on the Host. Agents invoke through a ConnectionRef;
            your vault login stays a separate door.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            dismissFirstRun();
            setHidden(true);
          }}
        >
          Dismiss
        </button>
      </div>
      <ul className="conn-list">
        {picks.map((provider) => {
          const connected = active.has(provider.id);
          return (
            <li key={provider.id} className="conn-service">
              <div>
                <h3>{provider.displayName}</h3>
                <p>
                  {connected
                    ? "Connected on this Host."
                    : provider.configured || provider.autoConfigurable
                      ? "Ready to authorize."
                      : "Needs a Host client registration first."}
                </p>
              </div>
              <Link
                className={`btn btn--sm${connected ? "" : " btn--primary"}`}
                to={connectorPath(provider.id)}
              >
                {connected ? "Open" : "Connect"}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PipeDiagram() {
  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>How to add a secret</h2>
          <p>
            Three pipes. Pick one. Mixing them is why GitHub feels like three
            products.
          </p>
        </div>
      </div>
      <ol className="conn-pipes">
        <li>
          <strong>Authorize the Host</strong>
          <p>
            OAuth or an API key. The Host keeps the credential and agents get a
            ConnectionRef. Use this for Linear, Stripe, OpenAI.
          </p>
        </li>
        <li>
          <strong>Save a vault login</strong>
          <p>
            Your password or passkey for a website. Only you can reveal it.
            Import a .env or password export if the vault is empty.
          </p>
        </li>
        <li>
          <strong>Point a vault secret at a ConnectionRef</strong>
          <p>
            A reminder and grant target. It does not copy the Host token into
            the vault.
          </p>
        </li>
      </ol>
    </section>
  );
}

function AddSecretChooser({
  provider,
  connection,
}: {
  provider: Provider;
  connection: Connection | null;
}) {
  const pipe = addPipe(provider);
  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Add to this identity</h2>
          <p>Choose the pipe. The Host never receives your vault password.</p>
        </div>
      </div>
      <div className="conn-chooser">
        <Link
          className={`btn ${pipe === "oauth" || pipe === "key" ? "btn--primary" : ""}`}
          to="#authorization"
        >
          {pipe === "oauth"
            ? "Authorize on the Host"
            : pipe === "key"
              ? "Save a key on the Host"
              : "Configure on the Host"}
        </Link>
        <Link className="btn" to={vaultCreateHref("login", provider)}>
          <IconLogin size={16} /> Save a site login
        </Link>
        {connection ? (
          <Link
            className="btn"
            to={vaultCreateHref("secret", provider, connection)}
          >
            <IconSecret size={16} /> Point a vault secret at this ConnectionRef
          </Link>
        ) : null}
        <Link className="btn" to="/settings/data#import">
          Import
        </Link>
      </div>
    </section>
  );
}

function IdentityGraphPanel({
  provider,
  connections,
  connection,
  onFlash,
  onChanged,
}: {
  provider: Provider;
  connections: Connection[];
  connection: Connection | null;
  onFlash: (flash: Flash | null) => void;
  onChanged: () => void;
}) {
  const { items } = useVault();
  const store = useVaultStore();
  const [busy, setBusy] = useState(false);
  const doors = graphDoors(provider, connections, items);
  const liveItems = items.filter((item) => item.deletedAt === null);
  const hasReminder =
    connection !== null && hasConnectorReminder(liveItems, connection);

  async function remember() {
    if (!connection) return;
    setBusy(true);
    try {
      await store.addItems([buildConnectorReminder(provider, connection)]);
      onFlash({
        tone: "ok",
        text: `Saved a vault reminder for ${provider.displayName}. The Host still holds the credential.`,
      });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  const icons = {
    host: IconConnection,
    login: IconLogin,
    passkey: IconPasskey,
    reminder: IconSecret,
  } as const;

  return (
    <section className="panel" id="identity">
      <div className="panel__head">
        <div>
          <h2>Also on this identity</h2>
          <p>
            Host connectors and vault items for {provider.displayName}. Not
            browser cookies, not <code>gh</code>, not a plugin card.
          </p>
        </div>
      </div>
      <ul className="conn-graph">
        {doors.map((door) => {
          const Icon = icons[door.kind];
          const rememberHere =
            door.kind === "reminder" &&
            door.action === "Remember" &&
            connection !== null &&
            !hasReminder;
          return (
            <li key={door.kind}>
              <Icon size={16} />
              <div>
                <strong>{door.title}</strong>
                <p>{door.detail}</p>
              </div>
              <div className="conn-graph__action">
                <span className={`chip ${VERB_CHIP[door.verb]}`}>
                  {VERB_LABEL[door.verb]}
                </span>
                {rememberHere ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={busy}
                    onClick={() => void remember()}
                  >
                    Remember
                  </button>
                ) : door.href ? (
                  <Link
                    className={`btn btn--sm${
                      door.action === "Fix" ||
                      door.action === "Authorize" ||
                      door.action === "Save a key"
                        ? " btn--primary"
                        : ""
                    }`}
                    to={door.href}
                  >
                    {door.action}
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <GrantToAgent
        provider={provider}
        connection={connection}
        onFlash={onFlash}
        onChanged={onChanged}
      />
      {connection ? (
        <div className="panel__body">
          <p className="conn-card__label">Recent activity</p>
          <ActivityLog connectionId={connection.connectionId} limit={5} />
        </div>
      ) : null}
    </section>
  );
}

function GrantToAgent({
  provider,
  connection,
  onFlash,
  onChanged,
}: {
  provider: Provider;
  connection: Connection | null;
  onFlash: (flash: Flash | null) => void;
  onChanged: () => void;
}) {
  const { items } = useVault();
  const store = useVaultStore();
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  if (!connection || connection.status === "revoked") return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const id = grantableAgentId(agentId);
    if (!id || !connection) {
      if (agentId.trim()) {
        onFlash({
          tone: "err",
          text: "Workload identity is an agent id (agt_…), not user:demo.",
        });
      }
      return;
    }
    setBusy(true);
    try {
      await bindConnection(connection.connectionId, {
        targetKind: "agent",
        targetId: id,
      });
      const existing = items.find(
        (item) =>
          item.kind === "secret" &&
          item.deletedAt === null &&
          item.connectionRef === connection.connectionRef,
      );
      if (existing) {
        await store.saveItem(grantReminderToAgent(existing, id));
      } else {
        const reminder = grantReminderToAgent(
          buildConnectorReminder(provider, connection),
          id,
        );
        await store.addItems([reminder]);
      }
      onFlash({
        tone: "ok",
        text: `${id} can invoke ${provider.displayName} through the Host. The vault reminder names that agent; the token stays on the Host.`,
      });
      setAgentId("");
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="conn-grant" onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label className="label" htmlFor={fieldId}>
          Grant to agent
        </label>
        <p className="hint">
          Binds this Host connector and records the agent on the vault reminder.
          Agents still receive a ConnectionRef, not the credential.
        </p>
        <div className="conn-grant__row">
          <input
            id={fieldId}
            value={agentId}
            spellCheck={false}
            placeholder="agt_release_bot"
            onChange={(event) => setAgentId(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn--sm btn--primary"
            disabled={busy || agentId.trim() === ""}
          >
            {busy ? "Granting…" : "Grant"}
          </button>
        </div>
      </div>
    </form>
  );
}

/* ============================================================ the gallery */

function GalleryPanel({
  providers,
  connections = [],
}: {
  providers: Provider[] | null;
  connections?: Connection[];
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const marketplaceProviders = (providers ?? []).filter(
    (provider) => !canConfigureAutomatically(provider),
  );
  const visibleProviders = marketplaceProviders.filter((provider) =>
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
      <div className="panel__head">
        <div>
          <h2>Connect a service</h2>
          <p>
            Approving one of these sends you to the provider&rsquo;s own consent
            screen. OpenSesame receives an authorization it can renew — never
            your password for that service.
          </p>
        </div>
      </div>

      <div className="panel__body">
        {providers === null ? (
          <p className="hint">Loading the built-in connector catalog…</p>
        ) : (
          <>
            <div className="conn-marketplace-tools">
              <label className="conn-search">
                <span className="sr-only">Search connectors</span>
                <IconSearch size={16} />
                <input
                  type="search"
                  placeholder="Search connectors"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <p className="hint" aria-live="polite">
                {visibleProviders.length} of {marketplaceProviders.length}{" "}
                connectors
              </p>
            </div>
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
  const summary = connectorSummary(provider);
  const verb = providerVerb(provider, connection);
  return (
    <li className={`conn-tile${provider.configured ? "" : " is-unconfigured"}`}>
      <Link
        className="conn-tile__head"
        to={connectorPath(provider.id)}
        title={summary}
      >
        <span className="conn-tile__name">{provider.displayName}</span>
        <span className="conn-tile__summary">{summary}</span>
        <span className="conn-tile__chips">
          {verb !== "idle" ? (
            <span className={`chip ${VERB_CHIP[verb]}`}>
              {VERB_LABEL[verb]}
            </span>
          ) : null}
          {provider.id === "openrouter" ? (
            <span className="chip chip--accent">Delegated sign-in</span>
          ) : provider.authKind === "api_key" ? (
            <span className="chip">API key</span>
          ) : provider.authKind === "configuration" ? (
            <span className="chip">Configuration</span>
          ) : provider.supportsRefresh ? (
            <span className="chip chip--accent">Renews itself</span>
          ) : (
            <span className="chip chip--warn">No refresh</span>
          )}
        </span>
        <span className="conn-tile__settings">
          <IconSettings size={16} /> Settings
        </span>
      </Link>
    </li>
  );
}
