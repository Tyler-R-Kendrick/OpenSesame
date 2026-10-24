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
  useLayoutEffect,
  useMemo,
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
  bindTarget: (saved: BackupTargetView) => void;
  beginDraft: () => void;
  current: () => boolean;
  target: BackupTargetView | null;
};

function backupRepoView(state: RepoView) {
  const selected = state.target
    ? `${state.target.owner}/${state.target.repo}`
    : "";
  const handlers = {
    connection: state.connection,
    online: state.online,
    onFlash: (flash: Flash) => {
      if (state.current()) state.onFlash(flash);
    },
    onBound: (saved: BackupTargetView) => {
      if (!state.current()) return;
      state.bindTarget(saved);
      state.setEditing(false);
      state.setDraft(`${saved.owner}/${saved.repo}`);
    },
    onIssue: (issue: string | null) => {
      if (state.current()) state.setIssue(issue);
    },
    onBusy: (busy: boolean) => {
      if (state.current()) state.setBusy(busy);
    },
    onReady: (ready: boolean) => {
      if (state.current()) state.onReady.current?.(ready);
    },
  };
  return {
    accounts: state.accounts,
    bound: isBound(state.target),
    busy: state.busy,
    connectionId: state.connection.connectionId,
    commit: (raw: string) =>
      state.current()
        ? commitRepoSlug(
            {
              handlers,
              selected,
              repos: state.repos,
              accounts: state.accounts,
              setRepos: (next) => {
                if (state.current()) state.setRepos(next);
              },
              setEditing: (next) => {
                if (state.current()) state.setEditing(next);
              },
            },
            raw,
            state.flight,
          )
        : Promise.resolve(),
    draft: state.draft,
    editing: state.editing,
    issue: state.issue,
    listError: state.listError,
    loading: state.loading,
    online: state.online,
    reload: state.reload,
    repos: state.repos,
    selected,
    beginDraft: state.beginDraft,
    setDraft: state.setDraft,
    setEditing: state.setEditing,
    setIssue: state.setIssue,
  };
}

type RepoOwner = {
  scope: string;
  /** The connection itself, apart from the account label shown for it. */
  identity: string;
  draftOwned: boolean;
  sequence: number;
  live: boolean;
  current(): boolean;
  flight: { current: boolean };
};
function useRepoOwner(connection: Connection) {
  const identity = JSON.stringify([
    connection.connectionId,
    connection.connectionRef,
    connection.providerId,
    connection.integrationId,
  ]);
  const scope = JSON.stringify([identity, connection.accountLabel]);
  const latest = useRef<RepoOwner | null>(null);
  const owner = useMemo(() => {
    const previous = latest.current;
    const next: RepoOwner = {
      scope,
      identity,
      // The same connection under another label (the account's login read
      // after its install) starts its lists again, but what the person is
      // typing stays theirs: a load must not write over it.
      draftOwned: previous?.identity === identity && previous.draftOwned,
      sequence: 0,
      live: false,
      flight: { current: false },
      current: () => latest.current === next && next.live,
    };
    return next;
  }, [scope, identity]);
  latest.current = owner;
  useLayoutEffect(() => {
    owner.live = true;
    return () => {
      owner.live = false;
      owner.sequence++;
    };
  }, [owner]);
  return owner;
}
function useRepoState(seedAccounts: AppInstallAccount[], owner: RepoOwner) {
  const [target, setTarget] = useState<BackupTargetView | null>(null);
  const [repos, setRepos] = useState<RepoChoice[]>([]);
  const [accounts, setAccounts] = useState(seedAccounts);
  const [draft, setDraft] = useState(DEFAULT_PASSWORD_REPO_NAME);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [issue, setIssue] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const targetRef = useRef<BackupTargetView | null>(null);
  const seed = useRef(seedAccounts);
  seed.current = seedAccounts;
  useLayoutEffect(() => {
    if (!owner.current()) return;
    targetRef.current = null;
    setTarget(null);
    setRepos([]);
    setAccounts(seed.current);
    if (!owner.draftOwned) {
      setDraft(DEFAULT_PASSWORD_REPO_NAME);
      setEditing(false);
    }
    setBusy(false);
    setLoading(true);
    setIssue(null);
    setListError(null);
  }, [owner]);
  return {
    target,
    setTarget,
    repos,
    setRepos,
    accounts,
    setAccounts,
    draft,
    setDraft,
    editing,
    setEditing,
    busy,
    setBusy,
    loading,
    setLoading,
    issue,
    setIssue,
    listError,
    setListError,
    targetRef,
  };
}
type ReloadOptions = {
  owner: RepoOwner;
  key: string;
  load: () => ReturnType<typeof loadRepoChoices>;
  publish: (loaded: Awaited<ReturnType<typeof loadRepoChoices>>) => void;
  loading: (value: boolean) => void;
};
function useRepoReload(options: ReloadOptions) {
  const latest = useRef(options);
  latest.current = options;
  const { owner, key } = options;
  const reload = useCallback(async () => {
    const original = latest.current;
    const turn = ++owner.sequence;
    const current = () =>
      owner.current() &&
      owner.sequence === turn &&
      latest.current.owner === owner &&
      latest.current.key === key;
    if (!current()) return;
    original.loading(true);
    try {
      const loaded = await original.load();
      if (current()) original.publish(loaded);
    } finally {
      if (current()) original.loading(false);
    }
  }, [owner, key]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return reload;
}
export function useGithubBackupRepo(
  connection: Connection,
  online: boolean,
  onFlash: (flash: Flash) => void,
  onReady?: (ready: boolean) => void,
  seedAccounts: AppInstallAccount[] = [],
  seedRepos: string[] = [],
) {
  const owner = useRepoOwner(connection);
  const state = useRepoState(seedAccounts, owner);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const key = JSON.stringify([
    connection.connectionId,
    seedKey(seedAccounts),
    seedReposKey(seedRepos),
  ]);
  const reload = useRepoReload({
    owner,
    key,
    load: () =>
      loadRepoChoices(
        connection,
        [...seedAccounts],
        [...seedRepos],
        state.targetRef.current,
      ),
    publish: (loaded) => {
      state.targetRef.current = loaded.target;
      state.setTarget(loaded.target);
      state.setAccounts(loaded.accounts);
      state.setRepos(loaded.repos);
      state.setListError(loaded.listError);
      onReadyRef.current?.(isBound(loaded.target));
      if (!owner.draftOwned) state.setDraft(loaded.draft);
    },
    loading: state.setLoading,
  });
  const setDraft: Dispatch<SetStateAction<string>> = (next) => {
    owner.draftOwned = true;
    state.setDraft(next);
  };
  return backupRepoView({
    ...state,
    connection,
    online,
    onFlash,
    onReady: onReadyRef,
    reload,
    flight: owner.flight,
    current: owner.current,
    setDraft,
    beginDraft: () => {
      owner.draftOwned = true;
      state.setEditing(true);
    },
    bindTarget: (saved) => {
      owner.sequence++;
      state.targetRef.current = saved;
      state.setTarget(saved);
      state.setLoading(false);
    },
  });
}
