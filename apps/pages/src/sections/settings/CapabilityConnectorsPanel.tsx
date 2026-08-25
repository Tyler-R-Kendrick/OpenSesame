import { useEffect, useState } from "react";
import { Link } from "react-router";
import { IconExternal, IconLock } from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import {
  CAPABILITIES,
  type CapabilityConnectorBinding,
  type CapabilityConnectorMap,
  type CapabilityId,
  connectorLabel,
} from "../../lib/capabilities.js";
import {
  type Connection,
  type Provider,
  authorizeConnection,
  awaitConsent,
  createConnection,
  listConnections,
  listIntegrations,
  listProviders,
  openConsentPopup,
  setConnectionCredential,
  startGithubAppRegistration,
  submitGithubAppManifest,
} from "../../lib/connections.js";
import {
  ensureHostSession,
  hostLocalSessionEligible,
  useConnect,
  useIdentitySession,
} from "../../lib/identity.js";
import { usePlaneStatus } from "../../lib/planes.js";
import {
  loadSettings,
  saveSettings,
  shouldAutoConnect,
} from "../../lib/settings.js";
import { useOnline } from "../../lib/use-online.js";
import { useStatusNotice } from "../../lib/use-status-notice.js";
import { GithubHistoryRemotePicker as GithubHistoryRemotePickerDefault } from "./GithubHistoryRemotePicker.js";

export const capabilityConnectorsSeams = {
  GithubHistoryRemotePicker: GithubHistoryRemotePickerDefault,
};

type Flash = { tone: "ok" | "err" | "warn"; text: string };

function githubAppFailureReason(raw: string | null): string {
  switch ((raw ?? "").trim()) {
    case "":
      return "unknown error";
    case "missing_state":
    case "missing_code":
      return "GitHub returned an incomplete redirect. Keep the Host running and try Create GitHub App again.";
    case "unknown_or_expired_state":
    case "expired_state":
      return "That registration session expired or the Host restarted. Create the GitHub App again (Host must stay up during the handshake).";
    case "conversion_failed":
      return "GitHub created the app but Host could not exchange the one-time code. Retry Create GitHub App while Host stays reachable.";
    default:
      return (raw ?? "").trim();
  }
}

function connectionFor(
  binding: CapabilityConnectorBinding,
  connections: Connection[],
): Connection | undefined {
  if (binding.connectionId) {
    const byId = connections.find(
      (c) => c.connectionId === binding.connectionId,
    );
    if (byId) return byId;
  }
  return (
    connections.find(
      (c) => c.providerId === binding.providerId && c.status === "active",
    ) ??
    connections.find(
      (c) =>
        c.providerId === binding.providerId &&
        (c.status === "pending" || c.status === "needs_reauth"),
    )
  );
}

function statusLabel(
  capabilityId: CapabilityId,
  binding: CapabilityConnectorBinding,
  connection: Connection | undefined,
) {
  const def = CAPABILITIES.find((c) => c.id === capabilityId);
  if (!def) return { tone: "idle", text: "Unknown" };
  if (!def.requiresAuth(binding.providerId)) {
    return {
      tone: "ok",
      text:
        binding.providerId === "webcrypto"
          ? "Active on this device"
          : "Ready (no Host auth required)",
    };
  }
  if (!connection) {
    return { tone: "warn", text: "Authorize this connector to sync" };
  }
  if (connection.status === "active") {
    return {
      tone: "ok",
      text: connection.accountLabel
        ? `Connected as ${connection.accountLabel}`
        : "Connected",
    };
  }
  if (connection.status === "pending" || connection.status === "needs_reauth") {
    return { tone: "warn", text: "Authorization incomplete" };
  }
  return { tone: "err", text: connection.statusDetail ?? connection.status };
}

export function CapabilityConnectorsPanel() {
  const planes = usePlaneStatus();
  const online = useOnline();
  const session = useIdentitySession();
  const { connecting, error: connectError, connect } = useConnect();
  // Session trouble is standing state, so it reports to the notifications
  // tray rather than a banner above the connector list.
  useStatusNotice(
    hostLocalSessionEligible()
      ? null
      : connectError
        ? {
            id: "identity-session",
            tone: "err",
            title: "Could not start an OpenSesame session",
            body: `${connectError}. Check the Identity URL in Settings (OpenSesame control plane — not a third-party IdP).`,
            retry: connect,
            retryLabel: "Try Identity again",
          }
        : connecting && !session
          ? {
              id: "identity-session",
              tone: "info",
              title: "Starting your OpenSesame session",
              body: "Connector OAuth and personal-access-token sealing unlock once the session is up.",
            }
          : null,
  );
  const [bindings, setBindings] = useState<CapabilityConnectorMap>(
    () => loadSettings().capabilityConnectors,
  );
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [githubOrgReady, setGithubOrgReady] = useState(false);
  const [githubOrgIntegrationId, setGithubOrgIntegrationId] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState<CapabilityId | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [patByCapability, setPatByCapability] = useState<
    Partial<Record<CapabilityId, string>>
  >({});

  async function refreshConnections() {
    try {
      setConnections(await listConnections());
    } catch {
      setConnections([]);
    }
  }

  async function refreshProviders() {
    try {
      setProviders(await listProviders());
    } catch {
      setProviders([]);
    }
    try {
      const rows = await listIntegrations();
      const orgGithub = rows.find(
        (row) =>
          row.providerId === "github" &&
          row.enabled &&
          row.configured &&
          row.source === "organization",
      );
      setGithubOrgReady(Boolean(orgGithub));
      setGithubOrgIntegrationId(orgGithub?.id ?? null);
    } catch {
      setGithubOrgReady(false);
      setGithubOrgIntegrationId(null);
    }
  }

  useEffect(() => {
    if (hostLocalSessionEligible()) return;
    if (session || !online || connecting || connectError) return;
    if (!shouldAutoConnect()) return;
    void connect();
  }, [session, online, connecting, connectError, connect]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Host/session changes intentionally trigger refresh
  useEffect(() => {
    void refreshConnections();
    void refreshProviders();
  }, [planes.host, session]);

  function persist(next: CapabilityConnectorMap) {
    setBindings(next);
    const current = loadSettings();
    saveSettings({ ...current, capabilityConnectors: next });
  }

  function updateBinding(
    id: CapabilityId,
    patch: Partial<CapabilityConnectorBinding>,
  ) {
    const current = bindings[id];
    const merged: CapabilityConnectorBinding = {
      providerId: patch.providerId ?? current.providerId,
    };
    const connectionId =
      patch.providerId &&
      patch.providerId !== current.providerId &&
      patch.connectionId === undefined
        ? undefined
        : patch.connectionId !== undefined
          ? patch.connectionId
          : current.connectionId;
    const remote = patch.remote !== undefined ? patch.remote : current.remote;
    if (connectionId) merged.connectionId = connectionId;
    if (remote) merged.remote = remote;
    persist({ ...bindings, [id]: merged });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: callback query params are consumed once on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("github_app");
    if (!result) return;
    if (result === "registered") {
      setFlash({
        tone: "ok",
        text: "GitHub App registered. Authorize History, then Install the App on your GitHub account (All repositories) so private password repos can be created.",
      });
      void refreshConnections();
      void refreshProviders();
    } else if (result === "installed") {
      setFlash({
        tone: "ok",
        text: "GitHub App installed. Authorize (or Re-authorize) if needed, then create or pick the password-store repo.",
      });
      void refreshConnections();
      void refreshProviders();
    } else if (result === "error") {
      setFlash({
        tone: "err",
        text: `GitHub App registration failed: ${githubAppFailureReason(
          params.get("reason"),
        )}`,
      });
    }
    params.delete("github_app");
    params.delete("reason");
    params.delete("integration");
    const next = `${window.location.pathname}${
      params.toString() ? `?${params}` : ""
    }${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, []);

  async function deployGithubApp(id: CapabilityId) {
    setBusy(id);
    setFlash(null);
    try {
      await ensureHostSession();
      const registration = await startGithubAppRegistration({
        returnTo: `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/?$/, "/")}settings`,
        displayName: "OpenSesame History",
      });
      setFlash({
        tone: "ok",
        text: "Sending you to GitHub to create the app…",
      });
      submitGithubAppManifest(registration);
      // Same-tab navigation. If CSP blocks form-action, we stay here — recover.
      window.setTimeout(() => {
        setBusy((current) => (current === id ? null : current));
        setFlash({
          tone: "err",
          text: "GitHub did not open. This page must allow form posts to github.com (CSP form-action). Hard-refresh and try again.",
        });
      }, 2500);
    } catch (error) {
      setFlash({
        tone: "err",
        text:
          error instanceof Error
            ? error.message
            : "Could not start GitHub App registration.",
      });
      setBusy(null);
    }
  }

  async function authorizeCapability(id: CapabilityId) {
    const def = CAPABILITIES.find((c) => c.id === id);
    if (!def) return;
    const binding = bindings[id];
    if (!def.requiresAuth(binding.providerId)) return;

    const providerMeta = providers.find((p) => p.id === binding.providerId);
    const oauthReady =
      providerMeta?.configured === true ||
      (binding.providerId === "github" && githubOrgReady);
    if (!oauthReady) {
      setFlash({
        tone: "warn",
        text:
          binding.providerId === "github"
            ? "Create the GitHub App above first (or paste a personal access token below). OAuth needs sealed client credentials on this Host."
            : `OAuth App is not configured on this Host yet${
                providerMeta?.missingConfig?.length
                  ? ` (${providerMeta.missingConfig.join(", ")})`
                  : ""
              }.`,
      });
      return;
    }

    // Popup must open on the click gesture; navigate it only after Host is ready.
    const popup = openConsentPopup("about:blank");
    setBusy(id);
    setFlash(null);
    try {
      await ensureHostSession();
      let connection = connectionFor(binding, connections);
      const scopes = def.authScopes?.(binding.providerId);
      if (!connection || connection.status === "revoked") {
        connection = await createConnection({
          providerId: binding.providerId,
          displayName:
            id === "history"
              ? `${connectorLabel(binding.providerId)} sealed-store history`
              : connectorLabel(binding.providerId),
          scopes,
          integrationId:
            binding.providerId === "github"
              ? (githubOrgIntegrationId ?? undefined)
              : undefined,
        });
      }
      const { authorizationUrl } = await authorizeConnection(
        connection.connectionId,
        scopes,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;

      const outcome = await awaitConsent(connection.connectionId, popup);
      await refreshConnections();
      if (outcome.result === "active") {
        updateBinding(id, {
          providerId: binding.providerId,
          connectionId: outcome.connection.connectionId,
          remote: binding.remote,
        });
        setFlash({
          tone: "ok",
          text:
            id === "history" && binding.providerId === "github"
              ? "GitHub authorized. Pick a repo or create a private opensesame-passwords store below."
              : `${connectorLabel(binding.providerId)} authorized for ${def.title.toLowerCase()}.`,
        });
      } else if (outcome.result === "failed") {
        setFlash({
          tone: "err",
          text:
            outcome.connection.statusDetail ??
            `${connectorLabel(binding.providerId)} refused authorization.`,
        });
      } else {
        updateBinding(id, {
          providerId: binding.providerId,
          connectionId: connection.connectionId,
          remote: binding.remote,
        });
        setFlash({
          tone: "warn",
          text: "Consent was not finished. You can authorize again from here or Connections.",
        });
      }
    } catch (error) {
      popup?.close();
      const message =
        error instanceof Error
          ? error.message
          : "Could not authorize this connector.";
      setFlash({
        tone: "err",
        text:
          binding.providerId === "github"
            ? `${message} Or paste a GitHub personal access token below (repo scope).`
            : message,
      });
    } finally {
      setBusy(null);
    }
  }

  async function connectWithPat(id: CapabilityId) {
    const def = CAPABILITIES.find((c) => c.id === id);
    if (!def) return;
    const binding = bindings[id];
    const token = (patByCapability[id] ?? "").trim();
    if (!token) {
      setFlash({ tone: "err", text: "Paste a personal access token first." });
      return;
    }
    setBusy(id);
    setFlash(null);
    try {
      await ensureHostSession();
      let connection = connectionFor(binding, connections);
      const scopes = def.authScopes?.(binding.providerId);
      if (!connection || connection.status === "revoked") {
        connection = await createConnection({
          providerId: binding.providerId,
          displayName:
            id === "history"
              ? `${connectorLabel(binding.providerId)} sealed-store history`
              : connectorLabel(binding.providerId),
          scopes,
        });
      }
      const active = await setConnectionCredential(
        connection.connectionId,
        token,
      );
      await refreshConnections();
      if (active.status !== "active") {
        throw new Error(
          active.statusDetail ??
            "Host stored the token but the connection is not active yet.",
        );
      }
      updateBinding(id, {
        providerId: binding.providerId,
        connectionId: active.connectionId,
        remote: binding.remote,
      });
      setPatByCapability((current) => ({ ...current, [id]: "" }));
      setFlash({
        tone: "ok",
        text:
          binding.providerId === "github"
            ? `GitHub connected${active.accountLabel ? ` as ${active.accountLabel}` : ""}. Pick or create a private password repo below.`
            : `${connectorLabel(binding.providerId)} connected with a personal access token.`,
      });
    } catch (error) {
      setFlash({
        tone: "err",
        text:
          error instanceof Error
            ? error.message
            : "Could not seal the personal access token on the Host.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Capability connectors</h2>
          <p>
            Each platform capability binds to a Host connector. Encryption
            defaults to WebCrypto on this device (the built-in key vault). Git
            history is optional — the vault already lives on this device.
            Connect GitHub with OAuth or a personal access token, then select a
            repo or create a private <code>opensesame-passwords</code> store.
            Host never returns provider tokens to this page.
          </p>
        </div>
      </div>
      <div className="panel__body">
        {hostLocalSessionEligible() ? (
          <p className="hint">
            Local Host is the authority for this tab — Identity plane not
            required for connector OAuth.
          </p>
        ) : null}
        <StatusNote message={flash} onDismiss={() => setFlash(null)} />

        <ul className="cap-list">
          {CAPABILITIES.map((def) => {
            const binding = bindings[def.id];
            const connection = connectionFor(binding, connections);
            const status = statusLabel(def.id, binding, connection);
            const needsAuth = def.requiresAuth(binding.providerId);
            const providerMeta = providers.find(
              (p) => p.id === binding.providerId,
            );
            const oauthReady =
              providerMeta?.configured === true ||
              (binding.providerId === "github" && githubOrgReady);
            const showPat =
              needsAuth &&
              (binding.providerId === "github" ||
                binding.providerId === "gitlab");
            return (
              <li key={def.id} className="cap-card">
                <div className="cap-card__head">
                  <div>
                    <h3>
                      <IconLock size={18} /> {def.title}
                    </h3>
                    <p>{def.summary}</p>
                  </div>
                  <span
                    className={`chip ${
                      status.tone === "ok"
                        ? "chip--ok"
                        : status.tone === "warn"
                          ? "chip--warn"
                          : status.tone === "err"
                            ? "chip--err"
                            : ""
                    }`}
                  >
                    {status.text}
                  </span>
                </div>

                <div className="field">
                  <label htmlFor={`cap-connector-${def.id}`}>Connector</label>
                  <select
                    id={`cap-connector-${def.id}`}
                    value={binding.providerId}
                    disabled={busy === def.id}
                    onChange={(event) =>
                      updateBinding(def.id, {
                        providerId: event.target.value,
                      })
                    }
                  >
                    {def.connectorIds.map((id) => (
                      <option key={id} value={id}>
                        {connectorLabel(id)}
                        {id === def.connectorIds[0] ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                {def.id === "history" && binding.providerId === "github"
                  ? (() => {
                      const Picker =
                        capabilityConnectorsSeams.GithubHistoryRemotePicker;
                      return (
                        <Picker
                          binding={binding}
                          connection={connection}
                          disabled={busy === def.id}
                          onSelectRemote={(remote) =>
                            updateBinding(def.id, {
                              providerId: binding.providerId,
                              connectionId: binding.connectionId,
                              remote,
                            })
                          }
                        />
                      );
                    })()
                  : null}

                {def.id === "history" && binding.providerId === "gitlab" ? (
                  <div className="field">
                    <label htmlFor="cap-history-remote">
                      Git remote for encrypted store
                    </label>
                    <input
                      id="cap-history-remote"
                      type="url"
                      placeholder="https://gitlab.com/org/opensesame-store.git"
                      value={binding.remote ?? ""}
                      disabled={busy === def.id}
                      onChange={(event) =>
                        updateBinding(def.id, {
                          providerId: binding.providerId,
                          connectionId: binding.connectionId,
                          remote: event.target.value,
                        })
                      }
                    />
                    <p className="hint">
                      GitLab repo picker is not wired yet — paste an https
                      remote after authorize.
                    </p>
                  </div>
                ) : null}

                <div className="actions">
                  {needsAuth ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy !== null || planes.host !== "live"}
                      aria-busy={busy === def.id}
                      onClick={() => void authorizeCapability(def.id)}
                    >
                      {busy === def.id
                        ? "Authorizing…"
                        : connection?.status === "active"
                          ? "Re-authorize with OAuth"
                          : `Authorize ${connectorLabel(binding.providerId)} (OAuth)`}
                    </button>
                  ) : (
                    <p className="hint">
                      No Host OAuth required for this connector.
                    </p>
                  )}
                  <Link
                    className="btn btn--ghost"
                    to={`/connections/${encodeURIComponent(binding.providerId)}`}
                  >
                    <IconExternal size={16} /> Open in Connections
                  </Link>
                </div>
                {needsAuth && planes.host !== "live" ? (
                  <p className="hint">
                    Host API is not reachable from this tab yet. Pair or start
                    the local Host so GitHub OAuth can complete.
                  </p>
                ) : null}
                {needsAuth &&
                planes.host === "live" &&
                !oauthReady &&
                binding.providerId === "github" ? (
                  <div className="cap-github-app">
                    <p className="hint">
                      OpenSesame deploys a tenant GitHub App for you — confirm
                      it on GitHub, Authorize, then Install the App on your
                      account (All repositories). Administration + Contents +
                      Workflows are required so History can create/list private
                      password repos and push ciphertext. OAuth alone is not
                      enough to create repos. No env vars or client secrets to
                      paste. On localhost, webhooks are omitted. If permissions
                      change, Create the App again, Authorize, and Install.
                    </p>
                    <p className="hint">
                      Prefer{" "}
                      <Link to="/settings/data#github-backup">
                        Settings → Data → GitHub persistence
                      </Link>{" "}
                      for Create App → Authorize → Install → private repo in one
                      place. You can still create the App here if you only need
                      History without backup.
                    </p>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={busy !== null || planes.host !== "live"}
                      aria-busy={busy === def.id}
                      onClick={() => void deployGithubApp(def.id)}
                    >
                      {busy === def.id
                        ? "Opening GitHub…"
                        : "Create GitHub App for this organization"}
                    </button>
                    <p className="hint">
                      Continues in this tab on github.com (not a popup). Confirm
                      the app there; GitHub returns you here when it is sealed.
                    </p>
                  </div>
                ) : null}
                {needsAuth &&
                planes.host === "live" &&
                !oauthReady &&
                binding.providerId !== "github" &&
                providerMeta?.missingConfig?.length ? (
                  <p className="hint">
                    OAuth App not configured on this Host (
                    {providerMeta.missingConfig.join(", ")}
                    ). Callback URL: <code>{providerMeta.callbackUrl}</code>
                  </p>
                ) : null}

                {showPat && planes.host === "live" ? (
                  <div className="field cap-pat">
                    <label htmlFor={`cap-pat-${def.id}`}>
                      Or connect with a personal access token
                    </label>
                    <input
                      id={`cap-pat-${def.id}`}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        binding.providerId === "github"
                          ? "ghp_… or github_pat_… (repo scope)"
                          : "glpat-…"
                      }
                      value={patByCapability[def.id] ?? ""}
                      disabled={busy === def.id}
                      onChange={(event) =>
                        setPatByCapability((current) => ({
                          ...current,
                          [def.id]: event.target.value,
                        }))
                      }
                    />
                    <p className="hint">
                      Sealed on the Host immediately. Never stored in this
                      browser. For GitHub history use a classic token with{" "}
                      <code>repo</code> or a fine-grained token that can create
                      private repositories.
                    </p>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={
                          busy !== null ||
                          !(patByCapability[def.id] ?? "").trim()
                        }
                        aria-busy={busy === def.id}
                        onClick={() => void connectWithPat(def.id)}
                      >
                        {busy === def.id
                          ? "Connecting…"
                          : `Connect ${connectorLabel(binding.providerId)} with token`}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
