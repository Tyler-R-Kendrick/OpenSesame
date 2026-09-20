import { useEffect, useState, useSyncExternalStore } from "react";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "../../lib/github-app-manifest.js";
import {
  type GithubAppPresenceState,
  loadGithubAppPresenceState,
  presenceFromLocal,
} from "../../lib/github-app-presence.js";
import { useVault } from "../../lib/vault/hooks.js";

/** Subscribe to local App + Host presence for the GitHub connector page. */
export function useGithubAppPresence(): {
  localApp: ReturnType<typeof readLocalGithubApp>;
  state: GithubAppPresenceState;
} {
  const { status } = useVault();
  const localApp = useSyncExternalStore(
    subscribeLocalGithubApp,
    readLocalGithubApp,
    () => null,
  );
  const [state, setState] = useState<GithubAppPresenceState>(() =>
    presenceFromLocal(readLocalGithubApp()),
  );

  useEffect(() => {
    // Reload when the vault lock state flips so claim/refresh after unlock
    // lands without a remount.
    void status;
    let cancel = false;
    let generation = 0;
    const reload = (): void => {
      const run = ++generation;
      void (async () => {
        const next = await loadGithubAppPresenceState(window.location.search);
        if (!cancel && run === generation) setState(next);
      })();
    };
    reload();
    const unsubscribe = subscribeLocalGithubApp(reload);
    return () => {
      cancel = true;
      unsubscribe();
    };
  }, [status]);

  useEffect(() => {
    if (localApp !== null) return;
    setState((previous) =>
      previous.appName === null &&
      previous.ownerLogin === null &&
      previous.ownerType === null &&
      previous.installs.length === 0 &&
      previous.backupRepo === null
        ? previous
        : presenceFromLocal(null),
    );
  }, [localApp]);

  return { localApp, state };
}
