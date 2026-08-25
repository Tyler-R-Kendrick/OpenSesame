import { repoHint } from "@opensesame/os-domain";
import { useEffect, useState } from "react";
import type { CapabilityConnectorBinding } from "../lib/capabilities.js";
import { capabilityDef, connectorLabel } from "../lib/capabilities.js";
import { bindCapabilityConnector } from "../lib/capability-bind.js";
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
} from "../lib/connections.js";
import { ensureHostSession } from "../lib/identity.js";
import { usePlaneStatus } from "../lib/planes.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { useSettingsEpoch } from "../lib/use-settings.js";
import { GithubHistoryRemotePicker as GithubHistoryRemotePickerDefault } from "../sections/settings/GithubHistoryRemotePicker.js";
import { type CeremonyAlt, CeremonyShell } from "./CeremonyShell.js";
import { FieldShell } from "./FieldShell.js";
import { IconGitBranch, IconPlus, IconSecret } from "./Icons.js";
import { StatusNote } from "./StatusNote.js";

type Flash = { tone: "ok" | "err" | "warn"; text: string };

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

function persistHistory(patch: Partial<CapabilityConnectorBinding>): void {
  const current = loadSettings();
  const prev = current.capabilityConnectors.history;
  const next: CapabilityConnectorBinding = {
    providerId: patch.providerId ?? prev.providerId,
  };
  const connectionId =
    patch.connectionId !== undefined ? patch.connectionId : prev.connectionId;
  const remote = patch.remote !== undefined ? patch.remote : prev.remote;
  if (connectionId) next.connectionId = connectionId;
  if (remote) next.remote = remote;
  saveSettings({
    ...current,
    capabilityConnectors: {
      ...current.capabilityConnectors,
      history: next,
    },
  });
}

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

/**
 * Connect git as optional persistence for the in-browser vault.
 *
 * Missing git is not an error. The ceremony authorizes a connector, then
 * binds a private repo — the same two steps Settings uses, in the sheet the
 * connectivity bar already opens for Host, Identity, and this machine.
 */
function ConnectGitHistoryDefault() {
  useSettingsEpoch();
  const planes = usePlaneStatus();
  const binding = loadSettings().capabilityConnectors.history;
  const def = capabilityDef("history");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [githubOrgReady, setGithubOrgReady] = useState(false);
  const [githubOrgIntegrationId, setGithubOrgIntegrationId] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [pat, setPat] = useState("");

  const connection = connectionFor(binding, connections);
  const needsAuth = def.requiresAuth(binding.providerId);
  const providerMeta = providers.find((p) => p.id === binding.providerId);
  const oauthReady =
    providerMeta?.configured === true ||
    (binding.providerId === "github" && githubOrgReady);
  const hostLive = planes.host === "live";

  async function refresh() {
    try {
      setConnections(await listConnections());
    } catch {
      setConnections([]);
    }
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: Host changes intentionally trigger refresh
  useEffect(() => {
    void refresh();
  }, [planes.host]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: github_app query is consumed once on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("github_app");
    if (!result) return;
    if (result === "registered") {
      setFlash({
        tone: "ok",
        text: "GitHub App registered. Authorize, then pick or create a private repo.",
      });
      void refresh();
    } else if (result === "installed") {
      setFlash({
        tone: "ok",
        text: "GitHub App installed. Authorize if needed, then pick or create a private repo.",
      });
      void refresh();
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

  async function authorize() {
    if (!needsAuth) return;
    if (!oauthReady) {
      setFlash({
        tone: "warn",
        text:
          binding.providerId === "github"
            ? "Create the GitHub App below first (or paste a personal access token). OAuth needs sealed client credentials on this Host."
            : `OAuth App is not configured on this Host yet${
                providerMeta?.missingConfig?.length
                  ? ` (${providerMeta.missingConfig.join(", ")})`
                  : ""
              }.`,
      });
      return;
    }
    const popup = openConsentPopup("about:blank");
    setBusy(true);
    setFlash(null);
    try {
      await ensureHostSession();
      let next = connectionFor(binding, connections);
      const scopes = def.authScopes?.(binding.providerId);
      if (!next || next.status === "revoked") {
        next = await createConnection({
          providerId: binding.providerId,
          displayName: `${connectorLabel(binding.providerId)} sealed-store history`,
          scopes,
          integrationId:
            binding.providerId === "github"
              ? (githubOrgIntegrationId ?? undefined)
              : undefined,
        });
      }
      const { authorizationUrl } = await authorizeConnection(
        next.connectionId,
        scopes,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;

      const outcome = await awaitConsent(next.connectionId, popup);
      await refresh();
      if (outcome.result === "active") {
        persistHistory({
          providerId: binding.providerId,
          connectionId: outcome.connection.connectionId,
          remote: binding.remote,
        });
        setFlash({
          tone: "ok",
          text:
            binding.providerId === "github"
              ? "GitHub authorized. Pick a repo or create a private store below."
              : `${connectorLabel(binding.providerId)} authorized. Bind a remote below.`,
        });
      } else if (outcome.result === "failed") {
        setFlash({
          tone: "err",
          text:
            outcome.connection.statusDetail ??
            `${connectorLabel(binding.providerId)} refused authorization.`,
        });
      } else {
        persistHistory({
          providerId: binding.providerId,
          connectionId: next.connectionId,
          remote: binding.remote,
        });
        setFlash({
          tone: "warn",
          text: "Consent was not finished. You can authorize again from here.",
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
      setBusy(false);
    }
  }

  async function connectWithPat() {
    const token = pat.trim();
    if (!token) {
      setFlash({ tone: "err", text: "Paste a personal access token first." });
      return;
    }
    setBusy(true);
    setFlash(null);
    try {
      await ensureHostSession();
      let next = connectionFor(binding, connections);
      const scopes = def.authScopes?.(binding.providerId);
      if (!next || next.status === "revoked") {
        next = await createConnection({
          providerId: binding.providerId,
          displayName: `${connectorLabel(binding.providerId)} sealed-store history`,
          scopes,
        });
      }
      const active = await setConnectionCredential(next.connectionId, token);
      await refresh();
      if (active.status !== "active") {
        throw new Error(
          active.statusDetail ??
            "Host stored the token but the connection is not active yet.",
        );
      }
      persistHistory({
        providerId: binding.providerId,
        connectionId: active.connectionId,
        remote: binding.remote,
      });
      setPat("");
      setFlash({
        tone: "ok",
        text: `${connectorLabel(binding.providerId)} connected${
          active.accountLabel ? ` as ${active.accountLabel}` : ""
        }. Pick or create a private repo below.`,
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
      setBusy(false);
    }
  }

  async function deployGithubApp() {
    setBusy(true);
    setFlash(null);
    try {
      await ensureHostSession();
      const registration = await startGithubAppRegistration({
        returnTo: `${window.location.origin}${window.location.pathname}`,
        displayName: "OpenSesame History",
      });
      setFlash({
        tone: "ok",
        text: "Sending you to GitHub to create the app…",
      });
      submitGithubAppManifest(registration);
      window.setTimeout(() => {
        setBusy(false);
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
      setBusy(false);
    }
  }

  function disconnect() {
    persistHistory({
      providerId: binding.providerId,
      connectionId: "",
      remote: "",
    });
    setFlash({
      tone: "ok",
      text: "Git disconnected. The vault stays on this device.",
    });
  }

  const Picker = connectGitHistorySeams.GithubHistoryRemotePicker;
  const showPat =
    needsAuth &&
    (binding.providerId === "github" || binding.providerId === "gitlab");
  const showCreateApp =
    needsAuth && hostLive && !oauthReady && binding.providerId === "github";
  const authorized = !needsAuth || connection?.status === "active";
  const bound = Boolean(binding.connectionId || binding.remote);

  // The same shape every other connector's ceremony wears: card, primary in
  // the card, alternatives as rows. This used to be a flat stack — a primary,
  // a ghost disconnect, a create-app block, a PAT field and a repo picker all
  // visible at once — which is exactly the three-buttons-side-by-side problem
  // the ceremony shape exists to remove.
  const alts: CeremonyAlt[] = [
    {
      id: "provider",
      label: "Use a different git provider",
      icon: <IconGitBranch size={18} />,
      render: () => (
        <div className="picker">
          {def.connectorIds
            .filter((id) => id !== binding.providerId)
            .map((id) => (
              <button
                key={id}
                type="button"
                className="picker__opt"
                disabled={busy}
                onClick={() => {
                  // Drops the connection on a provider change: consent given
                  // to GitHub must not be carried over as though GitLab had
                  // granted it.
                  bindCapabilityConnector("history", id);
                  setFlash({
                    tone: "ok",
                    text: `${connectorLabel(id)} bound. ${
                      capabilityDef("history").requiresAuth(id)
                        ? "Authorize it to finish."
                        : "Nothing else to do."
                    }`,
                  });
                }}
              >
                <IconGitBranch size={16} />
                <span>{connectorLabel(id)}</span>
              </button>
            ))}
        </div>
      ),
    },
    ...(showPat
      ? [
          {
            id: "pat",
            label: "Connect with a personal access token",
            icon: <IconSecret size={18} />,
            render: () =>
              hostLive ? (
                <>
                  <FieldShell
                    id="git-history-pat"
                    label="Personal access token"
                    type="password"
                    mono
                    autoComplete="off"
                    lead={<IconSecret size={17} />}
                    placeholder={
                      binding.providerId === "github"
                        ? "ghp_… or github_pat_… (repo scope)"
                        : "glpat-…"
                    }
                    value={pat}
                    onValueChange={setPat}
                    disabled={busy}
                  />
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy || !pat.trim()}
                      onClick={() => void connectWithPat()}
                    >
                      Connect with token
                    </button>
                  </div>
                </>
              ) : (
                <p className="hint">
                  Host API is not reachable from this tab yet. Pair or start the
                  local Host first — the token is sealed there, never held in
                  the browser.
                </p>
              ),
          },
        ]
      : []),
    ...(showCreateApp
      ? [
          {
            id: "github-app",
            label: "Create a GitHub App for this tenant",
            icon: <IconPlus size={18} />,
            render: () => (
              <>
                <p className="hint">
                  OpenSesame deploys a tenant GitHub App for you — confirm it on
                  GitHub, authorize, then install it on your account (All
                  repositories) so History can create private password repos.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy || !hostLive}
                    aria-busy={busy}
                    onClick={() => void deployGithubApp()}
                  >
                    {busy ? "Opening GitHub…" : "Create GitHub App"}
                  </button>
                </div>
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <CeremonyShell
        ok={authorized}
        top={
          !needsAuth
            ? "Local store — nothing to authorize"
            : authorized
              ? "Authorized"
              : "Not yet authorized"
        }
        name={
          binding.remote
            ? repoHint(binding.remote)
            : connectorLabel(binding.providerId)
        }
        facts={[
          { key: "Connector", value: connectorLabel(binding.providerId) },
          {
            key: "Remote",
            value: binding.remote ? repoHint(binding.remote) : "not chosen",
          },
        ]}
        primary={
          needsAuth
            ? {
                label: busy
                  ? "Authorizing…"
                  : connection?.status === "active"
                    ? "Re-authorize with OAuth"
                    : `Connect ${connectorLabel(binding.providerId)}`,
                onClick: () => void authorize(),
                busy,
                disabled: !hostLive,
              }
            : undefined
        }
        secondary={
          bound
            ? {
                label: "Disconnect git",
                onClick: disconnect,
                disabled: busy,
              }
            : undefined
        }
        alts={alts}
      >
        <p className="hint">
          The vault already lives on this device. Git is optional persistence —
          ciphertext only, never plaintext.
        </p>
        {needsAuth && !hostLive ? (
          <p className="hint">
            Host API is not reachable from this tab yet. Pair or start the local
            Host so OAuth can complete.
          </p>
        ) : null}
        {binding.providerId === "github" ? (
          <Picker
            binding={binding}
            connection={connection}
            disabled={busy}
            onSelectRemote={(remote) =>
              persistHistory({
                providerId: binding.providerId,
                connectionId: binding.connectionId,
                remote,
              })
            }
          />
        ) : null}
        {binding.providerId === "gitlab" ? (
          <FieldShell
            id="git-history-remote"
            label="Git remote for encrypted store"
            type="url"
            mono
            lead={<IconGitBranch size={17} />}
            placeholder="https://gitlab.com/org/opensesame-store.git"
            value={binding.remote ?? ""}
            disabled={busy}
            onValueChange={(value) =>
              persistHistory({
                providerId: binding.providerId,
                connectionId: binding.connectionId,
                remote: value,
              })
            }
          />
        ) : null}
        {!needsAuth ? (
          <p className="hint">
            Local git password-store needs no Host OAuth. Ciphertext stays on
            this machine.
          </p>
        ) : null}
      </CeremonyShell>
      <StatusNote message={flash} onDismiss={() => setFlash(null)} />
    </>
  );
}

export const connectGitHistorySeams = {
  GithubHistoryRemotePicker: GithubHistoryRemotePickerDefault,
  ConnectGitHistory: ConnectGitHistoryDefault,
};

export function ConnectGitHistory() {
  const Impl = connectGitHistorySeams.ConnectGitHistory;
  return <Impl />;
}
