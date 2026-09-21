import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BackupTargetView,
  filterPrivateGithubRepos,
  getBackupStatus,
} from "../../lib/backup.js";
import type { Connection } from "../../lib/connections.js";
import { refreshGithubAppInstallations } from "../../lib/github-app-manifest.js";
import {
  type AppInstallAccount,
  listGithubAppInstallationRepos,
  listLocalAppInstallAccounts,
} from "../../lib/github-app-repos.js";
import {
  DEFAULT_PASSWORD_REPO_NAME,
  listGithubRepos,
} from "../../lib/github-history.js";
import {
  type RepoChoice,
  isBound,
  mergeChoices,
} from "./GithubBackupRepoResolve.js";
import { commitRepoSlug } from "./githubBackupRepoActions.js";
import type { Flash } from "./shared.js";

export function useGithubBackupRepo(
  connection: Connection,
  online: boolean,
  onFlash: (flash: Flash) => void,
  onReady?: (ready: boolean) => void,
  seedAccounts: AppInstallAccount[] = [],
  seedRepos: string[] = [],
) {
  const [target, setTarget] = useState<BackupTargetView | null>(null);
  const [repos, setRepos] = useState<RepoChoice[]>([]);
  const [accounts, setAccounts] = useState<AppInstallAccount[]>(seedAccounts);
  const [draft, setDraft] = useState(DEFAULT_PASSWORD_REPO_NAME);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [issue, setIssue] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const onReadyRef = useRef(onReady);
  const flight = useRef(false);
  const targetRef = useRef<BackupTargetView | null>(null);
  const connectionRef = useRef(connection);
  const seedAccountsRef = useRef(seedAccounts);
  const seedReposRef = useRef(seedRepos);
  onReadyRef.current = onReady;
  connectionRef.current = connection;
  seedAccountsRef.current = seedAccounts;
  seedReposRef.current = seedRepos;
  const connectionId = connection.connectionId;
  const accountsKey = seedKey(seedAccounts);
  const reposKey = seedReposKey(seedRepos);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // Touch keys so the callback identity tracks connection + seed content.
      void connectionId;
      void accountsKey;
      void reposKey;
      const loaded = await loadRepoChoices(
        connectionRef.current,
        seedAccountsRef.current,
        seedReposRef.current,
        targetRef.current,
      );
      targetRef.current = loaded.target;
      setTarget(loaded.target);
      setAccounts(loaded.accounts);
      setRepos(loaded.repos);
      setListError(loaded.listError);
      onReadyRef.current?.(isBound(loaded.target));
      setDraft(loaded.draft);
    } finally {
      setLoading(false);
    }
  }, [connectionId, accountsKey, reposKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = target ? `${target.owner}/${target.repo}` : "";
  const handlers = {
    connection,
    online,
    onFlash,
    onBound: (saved: BackupTargetView) => {
      setTarget(saved);
      setEditing(false);
      setDraft(`${saved.owner}/${saved.repo}`);
    },
    onIssue: setIssue,
    onBusy: setBusy,
    onReady: (ready: boolean) => onReadyRef.current?.(ready),
  };

  return {
    accounts,
    bound: isBound(target),
    busy,
    commit: (raw: string) =>
      commitRepoSlug(
        {
          handlers,
          selected,
          repos,
          accounts,
          setRepos,
          setEditing,
        },
        raw,
        flight,
      ),
    draft,
    editing,
    issue,
    listError,
    loading,
    online,
    reload,
    repos,
    selected,
    setDraft,
    setEditing,
    setIssue,
  };
}

function seedKey(rows: AppInstallAccount[]): string {
  return rows
    .map((row) => `${row.installationId}:${row.accountLogin}`)
    .join("|");
}

function seedReposKey(names: string[]): string {
  return names.map((name) => name.toLowerCase()).join("|");
}

function mergeAccounts(
  primary: AppInstallAccount[],
  seed: AppInstallAccount[],
): AppInstallAccount[] {
  const out: AppInstallAccount[] = [];
  const seen = new Set<string>();
  for (const row of [...primary, ...seed]) {
    const key = row.installationId || row.accountLogin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function loadRepoChoices(
  connection: Connection,
  seedAccounts: AppInstallAccount[],
  seedRepos: string[],
  previousTarget: BackupTargetView | null,
) {
  await refreshGithubAppInstallations().catch(() => null);
  let statusError: string | null = null;
  const status = await getBackupStatus("github").catch(() => {
    statusError = "Could not load the backup target.";
    return null;
  });
  const target = status ? (status.target ?? null) : previousTarget;
  const accounts = mergeAccounts(listLocalAppInstallAccounts(), seedAccounts);
  const listed = await listGithubAppInstallationRepos().catch(() => ({
    repositories: [],
    error: "Could not list repositories for the GitHub App install.",
  }));
  let hostError: string | null = null;
  let hostRepos: Array<{ fullName: string }> = [];
  if (
    connection.connectionId !== "local-github-app" &&
    connection.status === "active"
  ) {
    try {
      hostRepos = filterPrivateGithubRepos(
        await listGithubRepos(connection.connectionId),
      );
    } catch {
      hostError = "Could not list repositories from the GitHub connection.";
    }
  }
  const repos = mergeChoices(
    listed.repositories,
    hostRepos,
    accounts,
    target,
    seedRepos,
  );
  let draft = DEFAULT_PASSWORD_REPO_NAME;
  if (target) draft = `${target.owner}/${target.repo}`;
  else if (accounts[0]) {
    draft = `${accounts[0].accountLogin}/${DEFAULT_PASSWORD_REPO_NAME}`;
  }
  const listError = listed.error ?? hostError ?? statusError;
  return {
    target,
    accounts,
    repos,
    draft,
    listError,
  };
}
