import { useCallback, useEffect, useMemo, useState } from "react";
import {
  branchForEnvironment,
  deleteBackupTarget,
  filterGithubBackupConnections,
  filterPrivateGithubRepos,
  getBackupStatus,
  githubAppFailureReason,
  githubAppInstallUrl,
  githubBackupReturnTo,
  installationIdFromLocation,
  listGithubInstallations,
  ownerRepoFromRemote,
  putBackupTarget,
  resyncBackup,
  type BackupStatus,
  type GithubInstallation,
} from "../../lib/backup.js";
import { CAPABILITIES } from "../../lib/capabilities.js";
import {
  awaitConsent,
  authorizeConnection,
  createConnection,
  listConnections,
  listIntegrations,
  openConsentPopup,
  startGithubAppRegistration,
  submitGithubAppManifest,
  type Connection,
  type Integration,
} from "../../lib/connections.js";
import {
  createGithubPasswordRepo,
  DEFAULT_PASSWORD_REPO_NAME,
  listGithubRepos,
  remoteFromRepo,
  type GithubRepoSummary,
} from "../../lib/github-history.js";
import {
  ensureHostSession,
  hostLocalSessionEligible,
  useIdentitySession,
} from "../../lib/identity.js";
import { usePlaneStatus } from "../../lib/planes.js";
import { loadSettings, saveSettings } from "../../lib/settings.js";
import { useOnline } from "../../lib/use-online.js";
import { IconAlert, IconCheck } from "../../components/Icons.js";

type Flash = { tone: "ok" | "err" | "warn"; text: string };

const HISTORY_SCOPES =
  CAPABILITIES.find((row) => row.id === "history")?.authScopes?.("github") ?? [
    "read:user",
    "repo",
    "workflow",
  ];

function bindHistoryConnection(connectionId: string) {
  const current = loadSettings();
  saveSettings({
    ...current,
    capabilityConnectors: {
      ...current.capabilityConnectors,
      history: {
        providerId: "github",
        connectionId,
        remote: current.capabilityConnectors.history?.remote,
      },
    },
  });
}

/**
 * One Settings panel for GitHub recoverability: Create App → Authorize →
 * Install → private repo → environment branch → save. No Connectivity detour.
 */
export function GithubBackupPanel() {
  const online = useOnline();
  const planes = usePlaneStatus();
  const session = useIdentitySession();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [orgGithub, setOrgGithub] = useState<Integration | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [installations, setInstallations] = useState<GithubInstallation[]>([]);
  const [installationId, setInstallationId] = useState("");
  const [repos, setRepos] = useState<GithubRepoSummary[]>([]);
  const [remote, setRemote] = useState("");
  const [environment, setEnvironment] = useState<
    "development" | "staging" | "production"
  >("production");
  const [newRepoName, setNewRepoName] = useState(DEFAULT_PASSWORD_REPO_NAME);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);

  const hostLive = planes.host === "live";
  const githubConnections = useMemo(
    () => filterGithubBackupConnections(connections),
    [connections],
  );
  const selected = githubConnections.find(
    (row) => row.connectionId === connectionId,
  );
  const appReady = Boolean(orgGithub?.configured);
  const connectionActive = selected?.status === "active";
  const installUrl = githubAppInstallUrl({
    htmlUrl: orgGithub?.githubAppHtmlUrl,
    displayName: orgGithub?.displayName,
  });

  const refresh = useCallback(async () => {
    if (!online) return;
    try {
      if (hostLocalSessionEligible() || session) {
        await ensureHostSession().catch(() => undefined);
      }
      const [nextStatus, nextConnections, integrations] = await Promise.all([
        getBackupStatus().catch(() => null),
        listConnections().catch(() => [] as Connection[]),
        listIntegrations().catch(() => [] as Integration[]),
      ]);
      if (nextStatus) setStatus(nextStatus);
      setConnections(nextConnections);
      const org =
        integrations.find(
          (row) =>
            row.providerId === "github" &&
            row.enabled &&
            row.configured &&
            row.source === "organization",
        ) ?? null;
      setOrgGithub(org);

      const github = filterGithubBackupConnections(nextConnections);
      if (
        nextStatus?.target &&
        github.some(
          (row) => row.integrationId === nextStatus.target?.integrationId,
        )
      ) {
        const match =
          github.find(
            (row) =>
              row.integrationId === nextStatus.target?.integrationId &&
              row.status === "active",
          ) ??
          github.find(
            (row) => row.integrationId === nextStatus.target?.integrationId,
          );
        if (match) setConnectionId(match.connectionId);
        setInstallationId(nextStatus.target.installationId);
        setRemote(
          `https://github.com/${nextStatus.target.owner}/${nextStatus.target.repo}`,
        );
        if (nextStatus.target.branch.startsWith("env/")) {
          const env = nextStatus.target.branch.slice("env/".length);
          if (
            env === "development" ||
            env === "staging" ||
            env === "production"
          ) {
            setEnvironment(env);
          }
        }
      } else if (!connectionId && github[0]) {
        setConnectionId(github[0].connectionId);
      }
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? caught.message
            : "Could not load GitHub backup status",
      });
    }
  }, [online, session, connectionId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("github_app");
    const fromUrl = installationIdFromLocation(window.location.search);
    if (fromUrl) setInstallationId(fromUrl);
    if (result === "registered") {
      setFlash({
        tone: "ok",
        text: "GitHub App registered. Authorize below, then Install on your account (All repositories).",
      });
      if (window.location.hash !== "#github-backup") {
        window.location.hash = "github-backup";
      }
    } else if (result === "installed") {
      setFlash({
        tone: "ok",
        text: "GitHub App installed. Pick a private repo and save the backup target.",
      });
      if (window.location.hash !== "#github-backup") {
        window.location.hash = "github-backup";
      }
    } else if (result === "error") {
      setFlash({
        tone: "err",
        text: `GitHub App registration failed: ${githubAppFailureReason(
          params.get("reason"),
        )}`,
      });
    }
    if (result) {
      params.delete("github_app");
      params.delete("reason");
      params.delete("integration");
      params.delete("installation_id");
      const next = `${window.location.pathname}${
        params.toString() ? `?${params}` : ""
      }#github-backup`;
      window.history.replaceState({}, "", next);
    }
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    async function loadInstallationsAndRepos() {
      if (!selected?.integrationId && !orgGithub?.id) {
        setInstallations([]);
        setRepos([]);
        return;
      }
      if (selected && selected.status !== "active") {
        setRepos([]);
      }
      setLoadingRepos(true);
      try {
        const integrationId = selected?.integrationId ?? orgGithub?.id ?? "";
        const [nextInstalls, nextRepos] = await Promise.all([
          integrationId
            ? listGithubInstallations(integrationId).catch(() => [])
            : Promise.resolve([]),
          selected?.status === "active"
            ? listGithubRepos(selected.connectionId)
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setInstallations(nextInstalls);
        setRepos(filterPrivateGithubRepos(nextRepos));
        if (!installationId && nextInstalls.length === 1 && nextInstalls[0]) {
          setInstallationId(nextInstalls[0].id);
        }
      } catch (caught) {
        if (!cancelled) {
          setRepos([]);
          setFlash({
            tone: "err",
            text:
              caught instanceof Error
                ? caught.message
                : "Could not load GitHub repos",
          });
        }
      } finally {
        if (!cancelled) setLoadingRepos(false);
      }
    }
    void loadInstallationsAndRepos();
    return () => {
      cancelled = true;
    };
  }, [
    selected?.connectionId,
    selected?.integrationId,
    selected?.status,
    orgGithub?.id,
    installationId,
  ]);

  async function onCreateApp() {
    setBusy("create-app");
    setFlash(null);
    try {
      await ensureHostSession();
      const registration = await startGithubAppRegistration({
        returnTo: githubBackupReturnTo(),
        displayName: "OpenSesame Recoverability",
      });
      setFlash({
        tone: "ok",
        text: "Sending you to GitHub to create the app…",
      });
      submitGithubAppManifest(registration);
      window.setTimeout(() => {
        setBusy((current) => (current === "create-app" ? null : current));
        setFlash({
          tone: "err",
          text: "GitHub did not open. This page must allow form posts to github.com (CSP form-action). Hard-refresh and try again.",
        });
      }, 2500);
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? caught.message
            : "Could not start GitHub App registration",
      });
      setBusy(null);
    }
  }

  async function onAuthorize() {
    const popup = openConsentPopup("about:blank");
    setBusy("authorize");
    setFlash(null);
    try {
      await ensureHostSession();
      let connection =
        selected ??
        githubConnections.find((row) => row.status !== "revoked") ??
        null;
      if (!connection || connection.status === "revoked") {
        connection = await createConnection({
          providerId: "github",
          displayName: "GitHub sealed-store recoverability",
          scopes: HISTORY_SCOPES,
          integrationId: orgGithub?.id,
        });
      }
      setConnectionId(connection.connectionId);
      const { authorizationUrl } = await authorizeConnection(
        connection.connectionId,
        HISTORY_SCOPES,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;

      const outcome = await awaitConsent(connection.connectionId, popup);
      await refresh();
      if (outcome.result === "active") {
        setConnectionId(outcome.connection.connectionId);
        bindHistoryConnection(outcome.connection.connectionId);
        setFlash({
          tone: "ok",
          text: "GitHub authorized. Install the App on your account if you have not already, then pick a private repo.",
        });
      } else if (outcome.result === "failed") {
        setFlash({
          tone: "err",
          text:
            outcome.connection.statusDetail ??
            "GitHub refused authorization.",
        });
      } else {
        setFlash({
          tone: "warn",
          text: "Consent was not finished. You can authorize again from this panel.",
        });
      }
    } catch (caught) {
      popup?.close();
      setFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? caught.message
            : "Could not authorize GitHub",
      });
    } finally {
      setBusy(null);
    }
  }

  function onInstall() {
    if (!installUrl) {
      setFlash({
        tone: "warn",
        text: "Open github.com → Settings → Applications → Installed GitHub Apps and install OpenSesame Recoverability (All repositories), then refresh.",
      });
      window.open("https://github.com/settings/installations", "_blank", "noopener");
      return;
    }
    setFlash({
      tone: "ok",
      text: "Opening GitHub to install the App. Choose All repositories, then you will return here.",
    });
    window.location.assign(installUrl);
  }

  async function onSave() {
    setBusy("save");
    setFlash(null);
    try {
      if (!selected) {
        throw new Error("Authorize GitHub in this panel first.");
      }
      if (!selected.integrationId && !orgGithub?.id) {
        throw new Error("Create the GitHub App in this panel first.");
      }
      const parsed = ownerRepoFromRemote(remote);
      if (!parsed) {
        throw new Error("Pick or create a private GitHub repository.");
      }
      if (!installationId.trim()) {
        throw new Error(
          "Install the App on GitHub, then select the installation below.",
        );
      }
      await putBackupTarget({
        connectionId: selected.connectionId,
        installationId: installationId.trim(),
        owner: parsed.owner,
        repo: parsed.repo,
        branch: branchForEnvironment(environment),
        enabled: true,
      });
      bindHistoryConnection(selected.connectionId);
      setFlash({
        tone: "ok",
        text: `Backup target saved → ${parsed.owner}/${parsed.repo}@${branchForEnvironment(environment)}. Vault changes will commit sealed ciphertext there.`,
      });
      await refresh();
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? caught.message
            : "Could not save backup target",
      });
    } finally {
      setBusy(null);
    }
  }

  async function onCreateRepo() {
    if (!selected?.connectionId) return;
    setBusy("create-repo");
    setFlash(null);
    try {
      const created = await createGithubPasswordRepo(selected.connectionId, {
        name: newRepoName,
        private: true,
      });
      setRemote(remoteFromRepo(created));
      setRepos(
        filterPrivateGithubRepos(
          await listGithubRepos(selected.connectionId),
        ),
      );
      setFlash({
        tone: "ok",
        text: `Created private ${created.fullName}. Save backup target to bind it.`,
      });
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? caught.message
            : "Could not create private repo",
      });
    } finally {
      setBusy(null);
    }
  }

  async function onResync() {
    setBusy("resync");
    setFlash(null);
    try {
      await resyncBackup();
      setFlash({ tone: "ok", text: "Full resync queued." });
      await refresh();
    } catch (caught) {
      setFlash({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Resync failed",
      });
    } finally {
      setBusy(null);
    }
  }

  async function onClear() {
    setBusy("clear");
    setFlash(null);
    try {
      await deleteBackupTarget();
      setStatus({ target: null, pendingEvents: 0 });
      setFlash({
        tone: "warn",
        text: "Backup target removed. New vault changes will not reach GitHub until you configure one again.",
      });
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error ? caught.message : "Could not clear target",
      });
    } finally {
      setBusy(null);
    }
  }

  const target = status?.target;
  const healthy =
    target?.enabled &&
    target.status === "ok" &&
    (status?.pendingEvents ?? 0) === 0;
  const anyBusy = busy !== null;

  return (
    <section className="panel" id="github-backup">
      <div className="panel__head">
        <div>
          <h2>GitHub recoverability</h2>
          <p>
            Set up recoverability here end-to-end: create the GitHub App,
            authorize, install it, pick a private repo, and map each environment
            to a branch (<code>env/development</code>, <code>env/staging</code>,{" "}
            <code>env/production</code>). Ciphertext only — Host never sees
            unlock keys.
          </p>
        </div>
      </div>
      <div className="panel__body">
        {!online ? (
          <p className="note">Connect to the network to configure backup.</p>
        ) : (
          <>
            {target ? (
              <p className={`note note--${healthy ? "ok" : "warn"}`}>
                {healthy ? <IconCheck /> : <IconAlert />}{" "}
                {target.owner}/{target.repo}@{target.branch} — status{" "}
                <strong>{target.status}</strong>
                {status && status.pendingEvents > 0
                  ? ` · ${status.pendingEvents} pending`
                  : ""}
                {target.lastCommitSha
                  ? ` · last commit ${target.lastCommitSha.slice(0, 7)}`
                  : ""}
                {target.lastError ? ` · ${target.lastError}` : ""}
              </p>
            ) : (
              <p className="note note--err" role="alert">
                <IconAlert /> No GitHub backup target — regenerating passwords
                will not create recoverable commits until you finish the steps
                below and save.
              </p>
            )}

            {!hostLive ? (
              <p className="note note--warn" role="status">
                Host API is not reachable from this tab yet. Pair or start the
                local Host so GitHub App setup can complete.
              </p>
            ) : null}

            <ol className="stack github-backup-steps">
              <li className="field">
                <strong>1. Create GitHub App</strong>
                {appReady ? (
                  <p className="note note--ok">
                    <IconCheck /> App ready
                    {orgGithub?.displayName
                      ? ` — ${orgGithub.displayName}`
                      : ""}
                  </p>
                ) : (
                  <p className="hint">
                    OpenSesame deploys a tenant GitHub App for you. Confirm it on
                    GitHub in this tab — no client secrets to paste.
                  </p>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className={appReady ? "btn" : "btn btn--primary"}
                    disabled={anyBusy || !hostLive}
                    aria-busy={busy === "create-app"}
                    onClick={() => void onCreateApp()}
                  >
                    {busy === "create-app"
                      ? "Opening GitHub…"
                      : appReady
                        ? "Recreate GitHub App"
                        : "Create GitHub App"}
                  </button>
                </div>
              </li>

              <li className="field">
                <strong>2. Authorize GitHub</strong>
                {connectionActive ? (
                  <p className="note note--ok">
                    <IconCheck /> Authorized
                    {selected?.accountLabel
                      ? ` as ${selected.accountLabel}`
                      : ""}
                  </p>
                ) : (
                  <p className="hint">
                    OAuth consent so this Host can list and create private
                    recoverability repos.
                  </p>
                )}
                {githubConnections.length > 1 ? (
                  <label className="field">
                    GitHub connection
                    <select
                      value={connectionId}
                      onChange={(event) => {
                        setConnectionId(event.target.value);
                        setRemote("");
                        setInstallationId("");
                        setRepos([]);
                        setInstallations([]);
                      }}
                    >
                      {githubConnections.map((row) => (
                        <option
                          key={row.connectionId}
                          value={row.connectionId}
                        >
                          {row.displayName || row.logicalName}
                          {row.accountLabel ? ` · ${row.accountLabel}` : ""}
                          {row.status !== "active" ? ` (${row.status})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <div className="actions">
                  <button
                    type="button"
                    className={
                      connectionActive ? "btn" : "btn btn--primary"
                    }
                    disabled={anyBusy || !hostLive || !appReady}
                    aria-busy={busy === "authorize"}
                    onClick={() => void onAuthorize()}
                  >
                    {busy === "authorize"
                      ? "Authorizing…"
                      : connectionActive
                        ? "Re-authorize"
                        : "Authorize GitHub"}
                  </button>
                </div>
              </li>

              <li className="field">
                <strong>3. Install the App</strong>
                {installations.length > 0 ? (
                  <p className="note note--ok">
                    <IconCheck /> {installations.length} installation
                    {installations.length === 1 ? "" : "s"} found
                  </p>
                ) : (
                  <p className="hint">
                    Install on your user or org with{" "}
                    <strong>All repositories</strong> so Host can push sealed
                    ciphertext.
                  </p>
                )}
                <label className="field">
                  Installation
                  <select
                    value={installationId}
                    onChange={(event) =>
                      setInstallationId(event.target.value)
                    }
                    disabled={!appReady}
                  >
                    <option value="">
                      {installations.length === 0
                        ? "Install on GitHub, then refresh…"
                        : "Select installation…"}
                    </option>
                    {installations.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.accountLogin} ({row.accountType}) · id {row.id}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="actions">
                  <button
                    type="button"
                    className={
                      installations.length > 0 ? "btn" : "btn btn--primary"
                    }
                    disabled={anyBusy || !hostLive || !appReady}
                    onClick={() => onInstall()}
                  >
                    {installations.length > 0
                      ? "Open Install page again"
                      : "Install App on GitHub"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={anyBusy || !hostLive}
                    onClick={() => void refresh()}
                  >
                    Refresh status
                  </button>
                </div>
              </li>

              <li className="field">
                <strong>4. Private repository</strong>
                <label className="field">
                  Repository
                  <select
                    value={remote}
                    disabled={
                      !connectionActive || loadingRepos || anyBusy
                    }
                    onChange={(event) => setRemote(event.target.value)}
                  >
                    <option value="">
                      {loadingRepos
                        ? "Loading private repos…"
                        : "Select a private repository…"}
                    </option>
                    {repos.map((repo) => (
                      <option key={repo.fullName} value={repo.cloneUrl}>
                        {repo.fullName} (private)
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field">
                  <label htmlFor="backup-new-repo">
                    Or create private password repo
                  </label>
                  <div className="actions">
                    <input
                      id="backup-new-repo"
                      value={newRepoName}
                      onChange={(event) =>
                        setNewRepoName(event.target.value)
                      }
                      disabled={anyBusy || !connectionActive}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={anyBusy || !connectionActive}
                      aria-busy={busy === "create-repo"}
                      onClick={() => void onCreateRepo()}
                    >
                      {busy === "create-repo"
                        ? "Creating…"
                        : "Create private repo"}
                    </button>
                  </div>
                </div>
              </li>

              <li className="field">
                <strong>5. Environment → branch</strong>
                <select
                  value={environment}
                  onChange={(event) =>
                    setEnvironment(
                      event.target.value as
                        | "development"
                        | "staging"
                        | "production",
                    )
                  }
                >
                  <option value="development">
                    development → {branchForEnvironment("development")}
                  </option>
                  <option value="staging">
                    staging → {branchForEnvironment("staging")}
                  </option>
                  <option value="production">
                    production → {branchForEnvironment("production")}
                  </option>
                </select>
                <span className="hint">
                  Each environment backs up to its own branch in the same
                  private repo. Production is the default recoverability
                  branch.
                </span>
              </li>
            </ol>

            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={anyBusy || !hostLive}
                aria-busy={busy === "save"}
                onClick={() => void onSave()}
              >
                {busy === "save" ? "Saving…" : "Save backup target"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={anyBusy || !target}
                onClick={() => void onResync()}
              >
                Resync now
              </button>
              <button
                type="button"
                className="btn"
                disabled={anyBusy || !target}
                onClick={() => void onClear()}
              >
                Remove
              </button>
            </div>

            {flash ? (
              <p
                className={`note note--${flash.tone}`}
                role={flash.tone === "err" ? "alert" : "status"}
              >
                {flash.text}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
