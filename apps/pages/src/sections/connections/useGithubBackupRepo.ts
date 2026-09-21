import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupTargetView } from "../../lib/backup.js";
import type { Connection } from "../../lib/connections.js";
import type { AppInstallAccount } from "../../lib/github-app-repos.js";
import { DEFAULT_PASSWORD_REPO_NAME } from "../../lib/github-history.js";
import { type RepoChoice, isBound } from "./GithubBackupRepoResolve.js";
import { commitRepoSlug } from "./githubBackupRepoActions.js";
import {
  loadRepoChoices,
  seedKey,
  seedReposKey,
} from "./githubBackupRepoLoad.js";
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
        { handlers, selected, repos, accounts, setRepos, setEditing },
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
