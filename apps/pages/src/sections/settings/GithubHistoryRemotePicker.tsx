import { useCallback, useEffect, useState } from "react";
import { StatusNote } from "../../components/StatusNote.js";
import type { CapabilityConnectorBinding } from "../../lib/capabilities.js";
import type { Connection } from "../../lib/connections.js";
import {
  DEFAULT_PASSWORD_REPO_NAME,
  type GithubRepoSummary,
  createGithubPasswordRepo,
  listGithubRepos,
  remoteFromRepo,
} from "../../lib/github-history.js";

type Props = {
  binding: CapabilityConnectorBinding;
  connection: Connection | undefined;
  disabled: boolean;
  onSelectRemote: (remote: string) => void;
};

export function GithubHistoryRemotePicker({
  binding,
  connection,
  disabled,
  onSelectRemote,
}: Props) {
  const [repos, setRepos] = useState<GithubRepoSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(DEFAULT_PASSWORD_REPO_NAME);
  const [error, setError] = useState<string | null>(null);

  const active =
    connection?.status === "active" && Boolean(connection.connectionId);

  const refreshRepos = useCallback(async () => {
    if (!connection?.connectionId || connection.status !== "active") {
      setRepos([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setRepos(await listGithubRepos(connection.connectionId));
    } catch (caught) {
      setRepos([]);
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not load repositories from GitHub.",
      );
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    void refreshRepos();
  }, [refreshRepos]);

  async function createPrivate() {
    if (!connection?.connectionId) return;
    setCreating(true);
    setError(null);
    try {
      const repo = await createGithubPasswordRepo(connection.connectionId, {
        name: newName,
        private: true,
      });
      onSelectRemote(remoteFromRepo(repo));
      await refreshRepos();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not create a private GitHub repository.",
      );
    } finally {
      setCreating(false);
    }
  }

  if (!active) {
    return (
      <p className="hint">
        Authorize GitHub above. Then pick an existing repo or create a{" "}
        <strong>private</strong> <code>{DEFAULT_PASSWORD_REPO_NAME}</code> repo
        (the default for encrypted password history).
      </p>
    );
  }

  return (
    <div className="cap-github">
      <div className="field">
        <label htmlFor="cap-history-repo">Repository for encrypted store</label>
        <select
          id="cap-history-repo"
          value={binding.remote ?? ""}
          disabled={disabled || loading || creating}
          onChange={(event) => {
            const value = event.target.value;
            if (value) onSelectRemote(value);
          }}
        >
          <option value="">
            {loading ? "Loading your GitHub repos…" : "Select a repository…"}
          </option>
          {repos.map((repo) => (
            <option key={repo.fullName} value={repo.cloneUrl}>
              {repo.fullName}
              {repo.private ? " (private)" : " (public)"}
            </option>
          ))}
        </select>
        <p className="hint">
          Repos come from the GitHub account you authorized — no manual git URL
          required. Ciphertext only; never commit an unlocked Pages manifest.
        </p>
      </div>

      <div className="field">
        <label htmlFor="cap-history-new-name">
          Create private password store (default)
        </label>
        <div className="actions">
          <input
            id="cap-history-new-name"
            type="text"
            value={newName}
            disabled={disabled || creating}
            onChange={(event) => setNewName(event.target.value)}
            placeholder={DEFAULT_PASSWORD_REPO_NAME}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={disabled || creating || !newName.trim()}
            aria-busy={creating}
            onClick={() => void createPrivate()}
          >
            {creating ? "Creating private repo…" : "Create private repo"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={disabled || loading || creating}
            onClick={() => void refreshRepos()}
          >
            Refresh list
          </button>
        </div>
        <p className="hint">
          Creates <code>{newName.trim() || DEFAULT_PASSWORD_REPO_NAME}</code> as{" "}
          <strong>private</strong> under your GitHub user, then binds it as the
          sealed-store remote. If create fails with a GitHub App connection,
          Install the App on your GitHub account (All repositories), then{" "}
          <strong>Re-authorize with OAuth</strong>, or paste a <code>repo</code>
          -scoped personal access token.
        </p>
      </div>

      {binding.remote ? (
        <p className="hint">
          Bound remote: <code>{binding.remote}</code>
        </p>
      ) : null}
      <StatusNote
        message={error ? { tone: "err", text: error } : null}
        onDismiss={() => setError(null)}
      />
    </div>
  );
}
