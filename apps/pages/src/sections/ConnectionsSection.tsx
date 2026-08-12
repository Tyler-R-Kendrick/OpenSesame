import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconConnection,
  IconExternal,
  IconInfo,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from "../components/Icons.js";
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
  listConnections,
  listProviders,
  openConsentPopup,
  refreshConnection,
  revokeConnection,
  setConnectionConfiguration,
  setConnectionCredential,
  unbindConnection,
} from "../lib/connections.js";
import {
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
  HostSessionError,
  hostBase,
  useConnect,
  useIdentitySession,
} from "../lib/identity.js";
import { useOnline } from "../lib/use-online.js";
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
  { value: "project", label: "Project" },
  { value: "agent", label: "Agent" },
  { value: "organization", label: "Organization" },
];

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
  pending: { tone: "chip--warn", label: "Awaiting consent" },
  active: { tone: "chip--ok", label: "Active" },
  needs_reauth: { tone: "chip--warn", label: "Needs re-authorization" },
  expired: { tone: "chip--warn", label: "Expired" },
  revoked: { tone: "chip", label: "Revoked" },
  error: { tone: "chip--err", label: "Error" },
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
      const nextConnections = await listConnections();
      if (connectionRun.current !== id) return;
      setConnections(nextConnections);
      setLoadError(null);
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
    void connect();
  }, [session, online, connecting, connectError, connect]);

  if (!session) {
    return (
      <div className="section__inner">
        <ConnectionsHead base={base} />
        <div className="panel">
          <div className="panel__body">
            <div className="empty conn-gate">
              <span className="empty__mark">
                <IconLock />
              </span>
              <h3>
                {connectError
                  ? "Identity connection failed"
                  : "Connecting to Identity…"}
              </h3>
              <p>
                Connections are held by the authority plane at{" "}
                <code>{base}</code>, not in your vault, so this page cannot read
                them from the device alone. OpenSesame connects automatically
                and asks the Host for a short-lived session scoped to you.
              </p>
              {connectError ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void connect()}
                  disabled={connecting || !online}
                  aria-busy={connecting}
                >
                  {connecting ? "Connecting…" : "Try again"}
                </button>
              ) : (
                <p className="hint conn-connecting">
                  <IconClock /> Establishing your private session…
                </p>
              )}
              <p className="hint">
                The Identity API approves this server-side. No deployment
                credential enters the browser.
              </p>
              {connectError ? (
                <div className="note note--err conn-error" role="alert">
                  <IconAlert />
                  <div className="conn-error__copy">
                    <strong>Could not connect to Identity</strong>
                    <p>{connectError}</p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {catalogError ? (
          <CatalogError failure={catalogError} onRetry={loadCatalog} />
        ) : null}
        <GalleryPanel
          providers={providers}
          online={online}
          canConfigure={false}
          onFlash={setFlash}
          onConnected={() => undefined}
        />
      </div>
    );
  }

  return (
    <div className="section__inner">
      <ConnectionsHead base={base} />

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

      {catalogError ? (
        <CatalogError failure={catalogError} onRetry={loadCatalog} />
      ) : null}

      <ConnectionsPanel
        connections={connections}
        providers={providers ?? []}
        loading={loading}
        online={online}
        onReload={() => void loadConnections()}
        onFlash={setFlash}
        setupRequired={loadError?.setupRequired === true}
      />

      <GalleryPanel
        providers={providers}
        online={online}
        canConfigure={loadError?.setupRequired !== true}
        onFlash={setFlash}
        onConnected={() => void loadConnections()}
      />
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

/* ======================================================= authorized services */

function ConnectionsPanel({
  connections,
  providers,
  loading,
  online,
  onReload,
  onFlash,
  setupRequired,
}: {
  connections: Connection[] | null;
  providers: Provider[];
  loading: boolean;
  online: boolean;
  onReload: () => void;
  onFlash: (flash: Flash) => void;
  setupRequired: boolean;
}) {
  const live = (connections ?? []).filter((c) => c.status !== "revoked");
  const revoked = (connections ?? []).filter((c) => c.status === "revoked");

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
        ) : live.length === 0 && revoked.length === 0 ? (
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
            {[...live, ...revoked].map((connection) => (
              <ConnectionCard
                key={connection.connectionId}
                connection={connection}
                provider={
                  providers.find((p) => p.id === connection.providerId) ?? null
                }
                online={online}
                onFlash={onFlash}
                onChanged={onReload}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ConnectionCard({
  connection,
  provider,
  online,
  onFlash,
  onChanged,
}: {
  connection: Connection;
  provider: Provider | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
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
    <li className={`conn-card${revoked ? " is-revoked" : ""}`}>
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

      {revoked ? null : (
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

function ActivityLog({ connectionId }: { connectionId: string }) {
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

  return (
    <ol className="conn-activity">
      {events.map((event) => (
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

/* ============================================================ the gallery */

function GalleryPanel({
  providers,
  online,
  canConfigure,
  onFlash,
  onConnected,
}: {
  providers: Provider[] | null;
  online: boolean;
  canConfigure: boolean;
  onFlash: (flash: Flash) => void;
  onConnected: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProviders = (providers ?? []).filter((provider) =>
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
                {visibleProviders.length} of {providers.length} connectors
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
                      online={online}
                      canConfigure={canConfigure}
                      expanded={open === provider.id}
                      onToggle={() =>
                        setOpen((current) =>
                          current === provider.id ? null : provider.id,
                        )
                      }
                      onFlash={onFlash}
                      onConnected={() => {
                        setOpen(null);
                        onConnected();
                      }}
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
  online,
  canConfigure,
  expanded,
  onToggle,
  onFlash,
  onConnected,
}: {
  provider: Provider;
  online: boolean;
  canConfigure: boolean;
  expanded: boolean;
  onToggle: () => void;
  onFlash: (flash: Flash) => void;
  onConnected: () => void;
}) {
  const summary = connectorSummary(provider);
  return (
    <li className={`conn-tile${provider.configured ? "" : " is-unconfigured"}`}>
      <button
        type="button"
        className="conn-tile__head"
        onClick={onToggle}
        aria-expanded={expanded}
        title={summary}
      >
        <span className="conn-tile__name">{provider.displayName}</span>
        <span className="conn-tile__summary">{summary}</span>
        <span className="conn-tile__chips">
          {provider.configured ? null : (
            <span className="chip">Not configured</span>
          )}
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
      </button>

      {expanded ? (
        !canConfigure ? (
          <div className="conn-tile__body">
            <p className="hint">
              Connection management becomes available after Identity and the
              Host establish your organization. The built-in catalog remains
              available now.
            </p>
          </div>
        ) : provider.configured ? (
          <ConnectForm
            provider={provider}
            online={online}
            onFlash={onFlash}
            onConnected={onConnected}
          />
        ) : (
          <div className="conn-tile__body">
            <DeploymentSetupGuide provider={provider} />
            <p className="hint">
              This Host is not ready to seal {provider.displayName} credentials.
              Configure the deployment setting below:
            </p>
            <ul className="conn-envs">
              {provider.missingConfig.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
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
}: {
  provider: Provider;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onConnected: () => void;
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
