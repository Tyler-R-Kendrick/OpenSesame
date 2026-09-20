import { useEffect, useState, useSyncExternalStore } from "react";
import { IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  forgetLocalGithubApp,
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "../../lib/github-app-manifest.js";
import {
  type GithubAppPresenceState,
  loadGithubAppPresenceState,
  presenceFromLocal,
} from "../../lib/github-app-presence.js";
import { useVault } from "../../lib/vault/hooks.js";

/**
 * App registrant + authenticated install accounts (org/user), names only.
 */
export function GithubAppPresence() {
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
    // Claim/refresh write the public record after this panel may already have
    // loaded empty — subscribe so the registrant appears without a remount.
    const unsubscribe = subscribeLocalGithubApp(reload);
    return () => {
      cancel = true;
      unsubscribe();
    };
  }, [status]);

  useEffect(() => {
    if (localApp !== null) return;
    // Forget / remote uninstall cleared the record — wipe stale presence now.
    setState((previous) =>
      previous.ownerLogin === null &&
      previous.ownerType === null &&
      previous.installs.length === 0
        ? previous
        : { ownerLogin: null, ownerType: null, installs: [] },
    );
  }, [localApp]);

  // Owner is only meaningful while a local App record exists. After Remove /
  // uninstall, drop it immediately even if a prior refresh is still in flight.
  const ownerLogin = localApp
    ? (state.ownerLogin ?? localApp.ownerLogin ?? null)
    : null;
  const ownerType = localApp
    ? state.ownerLogin
      ? state.ownerType
      : (localApp.ownerType ?? state.ownerType)
    : null;
  const hasApp = localApp !== null;
  if (!ownerLogin && state.installs.length === 0 && !hasApp) return null;

  return (
    <div className="conn-github-presence" data-testid="github-app-presence">
      {ownerLogin ? (
        <p className="conn-card__ref" data-testid="github-app-owner">
          <StatusMark tone="ok" label={`App registered on ${ownerLogin}`} />
          <span>
            {ownerLogin}
            {ownerType ? ` · ${ownerType}` : ""}
          </span>
        </p>
      ) : hasApp ? (
        <p className="conn-card__ref" data-testid="github-app-owner-missing">
          <StatusMark
            tone="warn"
            label="GitHub App registered; registrant not known yet"
          />
          <span>App registered · registrant unknown</span>
        </p>
      ) : null}
      {state.installs.map((row) => (
        <p
          key={row.id}
          className="conn-card__ref"
          data-testid="github-app-install"
        >
          <StatusMark
            tone="ok"
            label={`App installed on ${row.accountLogin}`}
          />
          <span>
            {row.accountLogin}
            {row.accountType ? ` · ${row.accountType}` : ""}
          </span>
        </p>
      ))}
      {hasApp ? (
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          data-testid="github-app-forget"
          aria-label="Remove GitHub App from this device"
          title="Remove GitHub App from this device"
          onClick={() => forgetLocalGithubApp()}
        >
          <IconTrash size={16} />
        </button>
      ) : null}
    </div>
  );
}
