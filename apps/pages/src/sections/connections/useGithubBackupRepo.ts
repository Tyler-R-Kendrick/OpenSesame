import type { BackupTargetView } from "@opensesame/app-core/lib/backup.js";
import type { Connection } from "@opensesame/app-core/lib/connections.js";
import type { AppInstallAccount } from "@opensesame/app-core/lib/github-app-repos.js";
import { DEFAULT_PASSWORD_REPO_NAME } from "@opensesame/app-core/lib/github-history.js";
import {
  type RepoChoice,
  isBound,
} from "@opensesame/app-core/sections/connections/GithubBackupRepoResolve.js";
import { commitRepoSlug } from "@opensesame/app-core/sections/connections/githubBackupRepoActions.js";
import {
  loadRepoChoices,
  seedKey,
  seedReposKey,
} from "@opensesame/app-core/sections/connections/githubBackupRepoLoad.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type RepoView = {
  accounts: AppInstallAccount[];
  busy: boolean;
  connection: Connection;
  draft: string;
  editing: boolean;
  flight: { current: boolean };
  issue: string | null;
  listError: string | null;
  loading: boolean;
  onFlash: (flash: Flash) => void;
  onReady: { current: ((ready: boolean) => void) | undefined };
  online: boolean;
  reload: () => Promise<void>;
  repos: RepoChoice[];
  setBusy: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setEditing: Dispatch<SetStateAction<boolean>>;
  setIssue: Dispatch<SetStateAction<string | null>>;
  setRepos: Dispatch<SetStateAction<RepoChoice[]>>;
  setTarget: Dispatch<SetStateAction<BackupTargetView | null>>;
  target: BackupTargetView | null;
};

function backupRepoView(state: RepoView) {
  const selected = state.target
    ? `${state.target.owner}/${state.target.repo}`
    : "";
  const handlers = {
    connection: state.connection,
    online: state.online,
    onFlash: state.onFlash,
    onBound: (saved: BackupTargetView) => {
      state.setTarget(saved);
      state.setEditing(false);
      state.setDraft(`${saved.owner}/${saved.repo}`);
    },
    onIssue: state.setIssue,
    onBusy: state.setBusy,
    onReady: (ready: boolean) => state.onReady.current?.(ready),
  };
  return {
    accounts: state.accounts,
    bound: isBound(state.target),
    busy: state.busy,
    connectionId: state.connection.connectionId,
    commit: (raw: string) =>
      commitRepoSlug(
        {
          handlers,
          selected,
          repos: state.repos,
          accounts: state.accounts,
          setRepos: state.setRepos,
          setEditing: state.setEditing,
        },
        raw,
        state.flight,
      ),
    draft: state.draft,
    editing: state.editing,
    issue: state.issue,
    listError: state.listError,
    loading: state.loading,
    online: state.online,
    reload: state.reload,
    repos: state.repos,
    selected,
    setDraft: state.setDraft,
    setEditing: state.setEditing,
    setIssue: state.setIssue,
  };
}

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
  const alive = useRef(true);
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
      if (!alive.current) return;
      targetRef.current = loaded.target;
      setTarget(loaded.target);
      setAccounts(loaded.accounts);
      setRepos(loaded.repos);
      setListError(loaded.listError);
      onReadyRef.current?.(isBound(loaded.target));
      setDraft(loaded.draft);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [connectionId, accountsKey, reposKey]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return backupRepoView({
    accounts,
    busy,
    connection,
    draft,
    editing,
    flight,
    issue,
    listError,
    loading,
    onFlash,
    onReady: onReadyRef,
    online,
    reload,
    repos,
    setBusy,
    setDraft,
    setEditing,
    setIssue,
    setRepos,
    setTarget,
    target,
  });
}
