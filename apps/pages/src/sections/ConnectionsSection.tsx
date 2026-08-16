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
  IconExternal,
  IconInfo,
  IconLock,
  IconLogin,
  IconPasskey,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSecret,
  IconSettings,
  IconTrash,
  IconX,
} from "../components/Icons.js";
import { PasskeyCeremonyNote } from "../components/PasskeyCeremonyNote.js";
import { PagesCannotHostNote } from "../components/PlaneNote.js";
import {
  type Binding,
  type BindingTargetKind,
  type Connection,
  type ConnectionEvent,
  type ConnectionStatus,
  ConnectionsError,
  type Provider,
  type ProviderCategory,
  authorizeConnection,
  awaitConsent,
  bindConnection,
  connectionEvents,
  createConnection,
  discoverConnections,
  listConnections,
  listProviders,
  openConsentPopup,
  refreshConnection,
  revokeConnection,
  setConnectionConfiguration,
  setConnectionCredential,
  unbindConnection,
  updateConnectionPolicy,
} from "../lib/connections.js";
import {
  canConfigureAutomatically,
  configurationDefaults,
  configurationPayload,
  connectorSteps,
  connectorSummary,
  fieldGuidance,
  needsScopeSelection,
} from "../lib/connector-guidance.js";
import {
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
  hostBase,
  useConnect,
  useIdentitySession,
} from "../lib/identity.js";
import { shouldAutoConnect } from "../lib/settings.js";
import { useOnline } from "../lib/use-online.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import "./connections.css";

type Flash = { tone: "ok" | "warn" | "err"; text: string };
type LoadFailure = {
  message: string;
  unreachable: boolean;
  setupRequired?: boolean;
};

const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  encryption: "Encryption (secrets in git)",
  cloud_secret_storage: "Cloud secret storage",
  password_managers: "Password managers",
  local_storage: "Local storage",
  developer: "Developer tools",
  productivity: "Productivity",
  communication: "Communication",
  storage: "Storage",
  crm: "CRM",
  payments: "Payments",
  identity: "Identity",
  testing: "Testing",
};

const CATEGORY_ORDER: ProviderCategory[] = [
  "encryption",
  "cloud_secret_storage",
  "password_managers",
  "local_storage",
  "developer",
  "productivity",
  "communication",
  "storage",
  "crm",
  "payments",
  "identity",
  "testing",
];

const BINDING_KINDS: Array<{ value: BindingTargetKind; label: string }> = [
  { value: "identity", label: "Identity" },
  { value: "group", label: "Group" },
  { value: "device", label: "Device" },
  { value: "project", label: "Project" },
  { value: "agent", label: "Agent" },
  { value: "organization", label: "Organization" },
];

function connectorPath(providerId: string, connectionId?: string): string {
  const provider = encodeURIComponent(providerId);
  return connectionId
    ? `/connections/${provider}/${encodeURIComponent(connectionId)}`
    : `/connections/${provider}`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : timeFormat.format(at);
}

/** "in 12 minutes" / "3 days ago", for horizons the user has to reason about. */
function relative(iso: string | null): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const seconds = Math.round((at - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  let value = seconds;
  for (const [unit, span] of units) {
    if (Math.abs(value) < span) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        value,
        unit,
      );
    }
    value = Math.round(value / span);
  }
  return null;
}

function errorText(error: unknown): string {
  if (error instanceof ConnectionsError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

const STATUS_CHIP: Record<ConnectionStatus, { tone: string; label: string }> = {
  pending: { tone: VERB_CHIP.needs_you, label: VERB_LABEL.needs_you },
  active: { tone: VERB_CHIP.connected, label: VERB_LABEL.connected },
  needs_reauth: { tone: VERB_CHIP.needs_you, label: VERB_LABEL.needs_you },
  expired: { tone: VERB_CHIP.needs_you, label: VERB_LABEL.needs_you },
  revoked: { tone: VERB_CHIP.idle, label: "Revoked" },
  error: { tone: VERB_CHIP.broken, label: VERB_LABEL.broken },
};

/** One sentence answering "is this working, and do I have to do anything?". */
function statusSentence(
  connection: Connection,
  provider?: Provider | null,
): string {
  const who = connection.accountLabel ? ` as ${connection.accountLabel}` : "";
  switch (connection.status) {
    case "pending":
      return "Created, but nobody has approved it yet. Authorize it to finish.";
    case "active": {
      if (provider?.authKind === "configuration") {
        return "Configuration saved on this Host and ready to bind to a project or agent.";
      }
      if (provider?.authKind === "api_key") {
        return `Credential stored${who}. It does not expire automatically.`;
      }
      const expiry = relative(connection.expiresAt);
      if (connection.refreshable) {
        return expiry
          ? `Authorized${who}. The access token expires ${expiry} and renews itself.`
          : `Authorized${who}. Renews itself; no further sign-in needed.`;
      }
      return expiry
        ? `Authorized${who}. This provider issues no refresh token, so it expires ${expiry} for good.`
        : `Authorized${who}. This provider issues a long-lived token with no refresh.`;
    }
    case "needs_reauth":
      return (
        connection.statusDetail ??
        "Renewal was refused by the provider. Authorize it again to restore it."
      );
    case "expired":
      return "The access token expired and there is no refresh token to renew it.";
    case "revoked":
      return "Revoked here. Its bindings and history are kept for the record.";
    case "error":
      return connection.statusDetail ?? "The provider returned an error.";
  }
}

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
    const embedded = await readEmbeddedProviders();
    if (catalogRun.current !== id) return;
    setProviders(embedded);
    try {
      const nextProviders = await listProviders();
      if (catalogRun.current !== id) return;
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
      } catch (error) {
        if (
          !(error instanceof ConnectionsError) ||
          ![403, 404].includes(error.status)
        ) {
          throw error;
        }
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
    if (!session) return;
    void loadConnections();
  }, [session, loadConnections]);

  useEffect(() => {
    if (session || !online || connecting || connectError) return;
    if (!shouldAutoConnect()) return;
    void connect();
  }, [session, online, connecting, connectError, connect]);

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
        canConfigure={session !== null && loadError?.setupRequired !== true}
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

      {loadError && !loadError.setupRequired ? (
        <div className="note note--err conn-error" role="alert">
          <IconAlert />
          <div className="conn-error__copy">
            <strong>
              {loadError.unreachable
                ? "Host API unavailable"
                : "Connections could not load"}
            </strong>
            <p>{loadError.message}</p>
            <p>
              {loadError.unreachable ? (
                <>
                  Start the configured Host service or{" "}
                  <Link to="/settings">review connection settings</Link>.
                </>
              ) : (
                "Try refreshing the connection list."
              )}
            </p>
          </div>
        </div>
      ) : null}

      {catalogError && (providers?.length ?? 0) === 0 ? (
        <CatalogError failure={catalogError} onRetry={loadCatalog} />
      ) : catalogError ? (
        <p className="note note--warn">
          <IconInfo /> Host catalog did not refresh. Showing the bundled
          connectors.{" "}
          <button type="button" className="btn btn--sm" onClick={loadCatalog}>
            Try again
          </button>
        </p>
      ) : null}

      <UnfinishedInbox
        connections={connections ?? []}
        providers={providers ?? []}
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
          <a href="#identity">This identity</a>
          <a href="#authorization">Authorization</a>
          <a href="#access">Who can use it</a>
          <a href="#rules">Rules</a>
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
          ) : provider.configured ? (
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
  const online = useOnline();
  if (session) return null;
  if (!shouldAutoConnect() && !connecting && !error) return null;
  return (
    <div className="note note--warn conn-session-note">
      <IconLock />
      <div>
        <p>
          {error
            ? "Identity is unreachable, so Host connectors cannot authorize yet. Vault logins, passkeys, and import still work on this device."
            : "Connecting to Identity so Host connectors can authorize. Vault items on this identity stay available either way."}
        </p>
        {error ? (
          <>
            <p>{error}</p>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void connect()}
              disabled={connecting || !online}
            >
              {connecting ? "Connecting…" : "Try Identity again"}
            </button>
          </>
        ) : connecting ? (
          <p className="hint conn-connecting">
            <IconClock /> Establishing your private session…
          </p>
        ) : null}
      </div>
    </div>
  );
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

function ConnectionCard({
  connection,
  provider,
  online,
  onFlash,
  onChanged,
  showBindings = true,
}: {
  connection: Connection;
  provider: Provider | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  showBindings?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const chip = STATUS_CHIP[connection.status];
  const revoked = connection.status === "revoked";

  async function act(
    label: string,
    work: () => Promise<unknown>,
    done: string,
  ) {
    setBusy(label);
    try {
      await work();
      onFlash({ tone: "ok", text: done });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  async function reauthorize() {
    const popup = openConsentPopup("about:blank");
    setBusy("authorize");
    try {
      const { authorizationUrl } = await authorizeConnection(
        connection.connectionId,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;
      const outcome = await awaitConsent(connection.connectionId, popup);
      if (outcome.result === "active") {
        onFlash({
          tone: "ok",
          text: `${connection.displayName} is authorized again.`,
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

  async function revoke() {
    setBusy("revoke");
    try {
      const result = await revokeConnection(connection.connectionId);
      const upstream = result.providerRevocation;
      onFlash(
        upstream === "ok"
          ? { tone: "ok", text: `${connection.displayName} was revoked.` }
          : {
              tone: "warn",
              text: `${connection.displayName} was removed locally, but provider revocation was ${upstream}. Revoke it in the provider's security settings too.`,
            },
      );
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  const scopes = connection.grantedScopes.length
    ? connection.grantedScopes
    : connection.requestedScopes;

  return (
    <li
      id={`connection-${connection.connectionId}`}
      className={`conn-card${revoked ? " is-revoked" : ""}`}
    >
      <div className="conn-card__top">
        <div className="conn-card__title">
          <h3>{connection.displayName}</h3>
          <p className="conn-card__ref">{connection.connectionRef}</p>
        </div>
        <div className="conn-card__chips">
          <span className={`chip ${chip.tone}`}>{chip.label}</span>
          {provider ? (
            <span className="chip">{provider.displayName}</span>
          ) : null}
        </div>
      </div>

      <p className="conn-card__status">
        {statusSentence(connection, provider)}
      </p>

      {scopes.length > 0 ? (
        <div className="conn-card__block">
          <p className="conn-card__label">Allowed to</p>
          <ul className="conn-scopes">
            {scopes.map((scope) => {
              const def = provider?.scopes.find((s) => s.name === scope);
              return (
                <li key={scope} title={def?.description ?? undefined}>
                  <code>{scope}</code>
                  {def ? <span>{def.description}</span> : null}
                  {def?.sensitive ? (
                    <span className="chip chip--warn chip--sm">broad</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {connection.egress.authorities.length > 0 ? (
        <p className="conn-card__egress">
          <IconInfo size={15} />
          The credential is only ever attached to{" "}
          <code>{connection.egress.scheme}</code> requests to{" "}
          {connection.egress.authorities.map((authority, index) => (
            <span key={authority}>
              {index > 0 ? ", " : ""}
              <code>{authority}</code>
              {/* Glued to the host so the period cannot wrap onto its own line. */}
              {index === connection.egress.authorities.length - 1 ? "." : ""}
            </span>
          ))}{" "}
          Anywhere else, it is not sent.
        </p>
      ) : null}

      {revoked || !showBindings ? null : (
        <BindingEditor
          connection={connection}
          online={online}
          onFlash={onFlash}
          onChanged={onChanged}
        />
      )}

      <div className="conn-card__foot">
        <div className="actions">
          {revoked ? null : (
            <>
              {connection.status === "active" && connection.refreshable ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy !== null || !online}
                  onClick={() =>
                    void act(
                      "refresh",
                      () => refreshConnection(connection.connectionId),
                      `${connection.displayName} was renewed.`,
                    )
                  }
                >
                  <IconRefresh size={16} />
                  {busy === "refresh" ? "Renewing…" : "Renew now"}
                </button>
              ) : null}
              {provider?.authKind === "oauth2_authorization_code" ? (
                <button
                  type="button"
                  className={`btn btn--sm${
                    connection.status === "active" ? "" : " btn--primary"
                  }`}
                  disabled={busy !== null || !online}
                  onClick={() => void reauthorize()}
                >
                  <IconExternal size={16} />
                  {busy === "authorize"
                    ? "Waiting for consent…"
                    : connection.status === "pending"
                      ? "Authorize"
                      : "Re-authorize"}
                </button>
              ) : null}
            </>
          )}
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setShowActivity((on) => !on)}
          >
            <IconClock size={16} />
            {showActivity ? "Hide history" : "History"}
          </button>
          {revoked ? null : (
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy !== null || !online}
              onClick={() => setConfirming(true)}
            >
              <IconTrash size={16} />
              Revoke
            </button>
          )}
        </div>
        <p className="conn-card__meta">
          Authorized {formatWhen(connection.createdAt)}
          {connection.lastRefreshedAt
            ? ` · renewed ${formatWhen(connection.lastRefreshedAt)}`
            : ""}
        </p>
      </div>

      {confirming ? (
        <div className="conn-confirm">
          <p>
            Revoking cuts off every project and agent bound to{" "}
            <strong>{connection.displayName}</strong> at once, and asks the
            provider to invalidate the token. Reconnecting means approving it
            again.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy !== null}
              onClick={() => {
                setConfirming(false);
                void revoke();
              }}
            >
              Revoke it
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      {showActivity ? (
        <ActivityLog connectionId={connection.connectionId} />
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------------- bindings */

function BindingEditor({
  connection,
  online,
  onFlash,
  onChanged,
}: {
  connection: Connection;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<BindingTargetKind>("project");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const kindId = useId();
  const targetId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const id = target.trim();
    if (!id) return;
    if (kind === "agent" && !grantableAgentId(id)) {
      onFlash({
        tone: "err",
        text: "Bind an agent, project, or device id — not user:demo.",
      });
      return;
    }
    setBusy(true);
    try {
      await bindConnection(connection.connectionId, {
        targetKind: kind,
        targetId: id,
      });
      setTarget("");
      setAdding(false);
      onFlash({
        tone: "ok",
        text: `${id} can now use ${connection.displayName}.`,
      });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(binding: Binding) {
    try {
      await unbindConnection(connection.connectionId, binding.id);
      onFlash({
        tone: "ok",
        text: `${binding.targetLabel ?? binding.targetId} can no longer use ${connection.displayName}.`,
      });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    }
  }

  return (
    <div className="conn-card__block">
      <p className="conn-card__label">Who can use it</p>
      {connection.bindings.length === 0 ? (
        <p className="hint conn-bindings__none">
          Nobody yet. The connection exists, but no project or agent can act
          through it until one is bound.
        </p>
      ) : (
        <ul className="conn-bindings">
          {connection.bindings.map((binding) => (
            <li key={binding.id}>
              <span className="conn-bindings__kind">{binding.targetKind}</span>
              <code>{binding.targetLabel ?? binding.targetId}</code>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Unbind ${binding.targetLabel ?? binding.targetId}`}
                disabled={!online}
                onClick={() => void remove(binding)}
              >
                <IconX size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form className="conn-bind-form" onSubmit={submit}>
          <div className="field">
            <label className="label" htmlFor={kindId}>
              Kind
            </label>
            <select
              id={kindId}
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as BindingTargetKind)
              }
            >
              {BINDING_KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor={targetId}>
              Identifier
            </label>
            <input
              id={targetId}
              value={target}
              placeholder="project_01J… or agent_01J…"
              onChange={(event) => setTarget(event.target.value)}
            />
          </div>
          <div className="actions">
            <button
              type="submit"
              className="btn btn--sm btn--primary"
              disabled={busy || !online || target.trim() === ""}
            >
              {busy ? "Binding…" : "Bind"}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={!online}
          onClick={() => setAdding(true)}
        >
          <IconPlus size={16} />
          Bind an identity
        </button>
      )}
    </div>
  );
}

function PolicyEditor({
  connection,
  online,
  onFlash,
  onChanged,
}: {
  connection: Connection;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const [shareability, setShareability] = useState(connection.shareability);
  const [maxInvokeLevel, setMaxInvokeLevel] = useState<1 | 2>(
    connection.maxInvokeLevel === 1 ? 1 : 2,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setShareability(connection.shareability);
    setMaxInvokeLevel(connection.maxInvokeLevel === 1 ? 1 : 2);
  }, [connection]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await updateConnectionPolicy(connection.connectionId, {
        shareability,
        maxInvokeLevel,
      });
      onFlash({ tone: "ok", text: "Connector rules saved." });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="conn-policy" onSubmit={submit}>
      <div className="field">
        <label className="label" htmlFor="connector-shareability">
          Delegation
        </label>
        <select
          id="connector-shareability"
          value={shareability}
          onChange={(event) =>
            setShareability(event.target.value as Connection["shareability"])
          }
        >
          <option value="private">Private to its owner</option>
          <option value="delegable">May be delegated through bindings</option>
          <option value="organization_wide">Available organization-wide</option>
        </select>
        <p className="hint">
          Bindings above still identify the groups, devices, identities, and
          workloads this authorization is intended for.
        </p>
      </div>
      <div className="field">
        <label className="label" htmlFor="connector-invoke-level">
          Maximum action
        </label>
        <select
          id="connector-invoke-level"
          value={maxInvokeLevel}
          onChange={(event) =>
            setMaxInvokeLevel(event.target.value === "1" ? 1 : 2)
          }
        >
          <option value={1}>Typed connector operations only</option>
          <option value={2}>Constrained provider requests</option>
        </select>
        <p className="hint">
          Credentials are never returned to a user, device, project, or agent.
        </p>
      </div>
      <dl className="conn-policy__facts">
        <div>
          <dt>Provider scope</dt>
          <dd>
            {connection.grantedScopes.length > 0
              ? connection.grantedScopes.join(", ")
              : "No delegated provider scopes"}
          </dd>
        </div>
        <div>
          <dt>Outbound boundary</dt>
          <dd>
            {connection.egress.authorities.length > 0
              ? `${connection.egress.scheme}://${connection.egress.authorities.join(", ")}`
              : "No outbound provider host"}
          </dd>
        </div>
      </dl>
      <button
        type="submit"
        className="btn btn--primary"
        disabled={busy || !online}
      >
        {busy ? "Saving…" : "Save rules"}
      </button>
    </form>
  );
}

function ActivityLog({
  connectionId,
  limit,
}: {
  connectionId: string;
  limit?: number;
}) {
  const [events, setEvents] = useState<ConnectionEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    connectionEvents(connectionId)
      .then((next) => {
        if (!cancelled) setEvents(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  if (error)
    return <p className="note note--err conn-activity__err">{error}</p>;
  if (events === null) return <p className="hint conn-pad">Reading history…</p>;
  if (events.length === 0)
    return <p className="hint conn-pad">No events recorded.</p>;

  const visible = limit ? events.slice(0, limit) : events;
  return (
    <ol className="conn-activity">
      {visible.map((event) => (
        <li key={event.id}>
          <span className="conn-activity__kind">
            {event.kind.replace(/_/g, " ")}
          </span>
          <span className="conn-activity__at">{formatWhen(event.at)}</span>
          {event.detail ? (
            <span className="conn-activity__detail">{event.detail}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/* =================================================== identity graph / inbox */

function UnfinishedInbox({
  connections,
  providers,
}: {
  connections: Connection[];
  providers: Provider[];
}) {
  const open = unfinishedConnections(connections);
  if (open.length === 0) return null;
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
                <Link
                  className="btn btn--sm btn--primary"
                  to={connectorPath(
                    connection.providerId,
                    connection.connectionId,
                  )}
                >
                  Fix
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
        <Link className="btn" to="/settings#import">
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

  const unconfigured = (providers ?? []).filter((p) => !p.configured).length;

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
            {unconfigured > 0 ? (
              <p className="note note--warn conn-unconfigured">
                <IconInfo />
                {unconfigured} of {providers.length} connectors are not ready to
                seal credentials on this Host. They remain visible with the
                exact deployment settings still needed.
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

function DeploymentSetupGuide({ provider }: { provider: Provider }) {
  const callback = `${hostBase()}/api/v1/oauth/callback/${provider.id}`;
  const delegated = provider.id === "openrouter";
  return (
    <div className="conn-setup-guide">
      <ol>
        <li>
          {delegated
            ? "No provider app registration is required; OpenRouter creates the key after the user approves access."
            : provider.authKind === "oauth2_authorization_code"
              ? "Create an OAuth app registration using the provider guide."
              : "Create the provider credential using the setup guide."}
        </li>
        {provider.authKind === "oauth2_authorization_code" && !delegated ? (
          <li>
            Register this exact callback URL: <code>{callback}</code>
          </li>
        ) : null}
        <li>
          Set the missing Host settings shown below, then restart the Host.
        </li>
      </ol>
      <a
        className="conn-doc-link"
        href={provider.docsUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        <IconExternal size={16} /> Open {provider.displayName} setup guide
      </a>
    </div>
  );
}

function ConnectorSetupGuide({ provider }: { provider: Provider }) {
  return (
    <div className="conn-setup-guide">
      <ol>
        {connectorSteps(provider).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <a
        className="conn-doc-link"
        href={provider.docsUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        <IconExternal size={16} /> Open {provider.displayName} setup guide
      </a>
    </div>
  );
}

function ConnectForm({
  provider,
  online,
  onFlash,
  onConnected,
  onRememberOffer,
}: {
  provider: Provider;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onConnected: () => void;
  onRememberOffer?: (connection: Connection) => void;
}) {
  const [name, setName] = useState(provider.displayName);
  const [scopes, setScopes] = useState<string[]>(() =>
    provider.scopes.filter((scope) => scope.default).map((scope) => scope.name),
  );
  const [apiKey, setApiKey] = useState("");
  const [configuration, setConfiguration] = useState<Record<string, string>>(
    () => configurationDefaults(provider),
  );
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const keyId = useId();
  const missingScope = needsScopeSelection(provider, scopes);

  function toggle(scope: string) {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((value) => value !== scope)
        : [...current, scope],
    );
  }

  async function connectOauth(event: FormEvent) {
    event.preventDefault();
    // Opened synchronously or the browser treats it as an unsolicited popup;
    // the real destination is set once the broker has issued the state.
    const popup = openConsentPopup("about:blank");
    setBusy(true);
    let created = false;
    try {
      const connection = await createConnection({
        providerId: provider.id,
        displayName: name.trim() || provider.displayName,
        scopes,
      });
      created = true;
      const { authorizationUrl } = await authorizeConnection(
        connection.connectionId,
        scopes,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;

      const outcome = await awaitConsent(connection.connectionId, popup);
      if (outcome.result === "active") {
        onFlash({
          tone: "ok",
          text: `${provider.displayName} is connected${
            outcome.connection.accountLabel
              ? ` as ${outcome.connection.accountLabel}`
              : ""
          }. Bind it to a project or agent to let them use it.`,
        });
        onRememberOffer?.(outcome.connection);
        onConnected();
      } else if (outcome.result === "failed") {
        onFlash({
          tone: "err",
          text:
            outcome.connection.statusDetail ??
            `${provider.displayName} refused the authorization.`,
        });
        onConnected();
      } else {
        onFlash({
          tone: "warn",
          text: `Consent for ${provider.displayName} was not completed. The connection is waiting, and you can authorize it above.`,
        });
        onConnected();
      }
    } catch (error) {
      popup?.close();
      onFlash({ tone: "err", text: errorText(error) });
      if (created) onConnected();
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    let created = false;
    try {
      const connection = await createConnection({
        providerId: provider.id,
        displayName: name.trim() || provider.displayName,
      });
      created = true;
      await setConnectionCredential(connection.connectionId, apiKey.trim());
      setApiKey("");
      onFlash({
        tone: "ok",
        text: `${provider.displayName} credential stored on this Host.`,
      });
      onRememberOffer?.(connection);
      onConnected();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
      if (created) onConnected();
    } finally {
      setBusy(false);
    }
  }

  async function saveConfiguration(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const form = event.currentTarget as HTMLFormElement;
    const payload = configurationPayload(provider, configuration);
    form.reset();
    setConfiguration(configurationDefaults(provider));
    let created = false;
    try {
      const connection = await createConnection({
        providerId: provider.id,
        displayName: name.trim() || provider.displayName,
      });
      created = true;
      await setConnectionConfiguration(connection.connectionId, payload);
      onFlash({
        tone: "ok",
        text: `${provider.displayName} configuration saved on this Host.`,
      });
      onRememberOffer?.(connection);
      onConnected();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
      if (created) onConnected();
    } finally {
      setBusy(false);
    }
  }

  if (provider.authKind === "configuration") {
    return (
      <form className="conn-tile__body" onSubmit={saveConfiguration}>
        <ConnectorSetupGuide provider={provider} />
        <div className="field">
          <label className="label" htmlFor={nameId}>
            Name it
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="hint">
            Only changes the label in OpenSesame; the provider never sees it.
          </p>
        </div>
        {(provider.configurationFields ?? []).map((field) => {
          const id = `${nameId}-${field.name}`;
          const guidance = fieldGuidance(field);
          const automatic = configurationDefaults(provider)[field.name];
          return (
            <div className="field" key={field.name}>
              <label className="label conn-field-label" htmlFor={id}>
                {field.label}
                {field.required ? " (required)" : " (optional)"}
                <span title={guidance.help} aria-hidden="true">
                  <IconInfo size={14} />
                </span>
              </label>
              <input
                id={id}
                name={field.name}
                type={
                  field.secret
                    ? "password"
                    : field.name.endsWith("_url")
                      ? "url"
                      : "text"
                }
                autoComplete="off"
                required={field.required}
                placeholder={guidance.placeholder}
                aria-describedby={`${id}-help`}
                title={guidance.help}
                value={configuration[field.name] ?? ""}
                onChange={(event) =>
                  setConfiguration((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
              />
              <p className="hint" id={`${id}-help`}>
                {guidance.help}
                {automatic ? " Filled automatically; change it if needed." : ""}
              </p>
            </div>
          );
        })}
        <p className="hint">
          Secret fields are sealed on arrival and are never returned to this
          browser.
        </p>
        <div className="actions">
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={busy || !online}
          >
            {busy ? "Saving…" : "Save configuration"}
          </button>
        </div>
      </form>
    );
  }

  if (provider.authKind === "api_key") {
    return (
      <form className="conn-tile__body" onSubmit={saveKey}>
        <ConnectorSetupGuide provider={provider} />
        <div className="field">
          <label className="label" htmlFor={nameId}>
            Name it
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="hint">
            Only changes the label in OpenSesame; the provider never sees it.
          </p>
        </div>
        <div className="field">
          <label className="label" htmlFor={keyId}>
            API key
          </label>
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            placeholder="Paste API key once"
            aria-describedby={`${keyId}-help`}
            title="Create a restricted API key in the provider console, then paste it here once."
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <p className="hint" id={`${keyId}-help`}>
            Sealed by the authority plane on arrival. It is not shown again
            here, and no agent can read it back.
          </p>
        </div>
        <div className="actions">
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={busy || !online || apiKey.trim() === ""}
          >
            {busy ? "Saving…" : `Connect ${provider.displayName}`}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="conn-tile__body" onSubmit={connectOauth}>
      <PasskeyCeremonyNote />
      <ConnectorSetupGuide provider={provider} />
      <div className="field">
        <label className="label" htmlFor={nameId}>
          Name it
        </label>
        <input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="hint">
          How it reads in this list. The provider never sees it.
        </p>
      </div>

      {provider.scopes.length > 0 ? (
        <fieldset className="conn-scope-picker">
          <legend className="label">Ask for</legend>
          {provider.scopes.map((scope) => (
            <label className="check" key={scope.name}>
              <input
                type="checkbox"
                checked={scopes.includes(scope.name)}
                onChange={() => toggle(scope.name)}
              />
              <span>
                <code>{scope.name}</code>
                {scope.sensitive ? (
                  <span className="chip chip--warn chip--sm">broad</span>
                ) : null}
                <span className="hint">{scope.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="actions">
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          disabled={busy || !online || missingScope}
        >
          <IconExternal size={16} />
          {busy
            ? "Waiting for consent…"
            : `Authorize with ${provider.displayName}`}
        </button>
      </div>
      {missingScope ? (
        <p className="hint">
          Pick at least one scope — an authorization with none can do nothing.
        </p>
      ) : null}
    </form>
  );
}
