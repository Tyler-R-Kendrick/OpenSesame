import { subscribeLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import {
  loadGithubAppPresenceState,
  presenceFromLocal,
} from "@opensesame/app-core/lib/github-app-presence.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useVault } from "../../lib/vault/hooks.js";

/** Subscribe to local App + Host presence for the GitHub connector page. */
export function useGithubAppPresence() {
  const { status } = useVault();
  const localApp = useSyncExternalStore(
    subscribeLocalGithubApp,
    readLocalGithubApp,
    () => null,
  );
  const [state, setState] = useState(() =>
    presenceFromLocal(readLocalGithubApp()),
  );

  useEffect(() => {
    // Reload when the vault lock state flips so claim/refresh after unlock
    // lands without a remount. Also when the backup target is bound/cleared.
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
    const unsubscribeApp = subscribeLocalGithubApp(reload);
    const unsubscribeBackup = subscribeLocalBackupTarget(reload);
    return () => {
      cancel = true;
      unsubscribeApp();
      unsubscribeBackup();
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
