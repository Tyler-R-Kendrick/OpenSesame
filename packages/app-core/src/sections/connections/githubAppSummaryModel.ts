import type { Connection } from "../../lib/connections.js";
import type { LocalGithubApp } from "../../lib/github-app-manifest.js";
import type { GithubAppPresenceState } from "../../lib/github-app-presence.js";

export type GithubAppSummaryModel = {
  visible: boolean;
  hasApp: boolean;
  appName: string | null;
  htmlUrl: string | null;
  ownerLogin: string | null;
  ownerType: string | null;
  ownerMissing: boolean;
  installs: GithubAppPresenceState["installs"];
  backupRepo: string | null;
  grantedPermissions: GithubAppPresenceState["grantedPermissions"];
  oauthRequested: { name: string; access: string }[];
  oauthGranted: { name: string; access: string }[];
};

function ownerFields(
  localApp: LocalGithubApp | null,
  state: GithubAppPresenceState,
): { ownerLogin: string | null; ownerType: string | null } {
  if (localApp === null) {
    return { ownerLogin: null, ownerType: null };
  }
  const ownerLogin = state.ownerLogin ?? localApp.ownerLogin ?? null;
  if (state.ownerLogin) {
    return { ownerLogin, ownerType: state.ownerType };
  }
  return {
    ownerLogin,
    ownerType: localApp.ownerType ?? state.ownerType,
  };
}

function scopeRows(
  names: string[] | undefined,
): { name: string; access: string }[] {
  return (names ?? []).map((name) => ({ name, access: "" }));
}

/** Flatten local App + live presence into the connector summary model. */
export function buildGithubAppSummaryModel(
  localApp: LocalGithubApp | null,
  state: GithubAppPresenceState,
  connection: Connection | null,
): GithubAppSummaryModel {
  const hasApp = localApp !== null;
  const { ownerLogin, ownerType } = ownerFields(localApp, state);
  const appName = state.appName ?? localApp?.displayName ?? null;
  const htmlUrl = state.htmlUrl ?? localApp?.htmlUrl ?? null;
  const visible = Boolean(
    ownerLogin ||
      state.installs.length > 0 ||
      hasApp ||
      appName ||
      state.backupRepo,
  );
  return {
    visible,
    hasApp,
    appName,
    htmlUrl,
    ownerLogin,
    ownerType,
    ownerMissing: hasApp && ownerLogin === null,
    installs: state.installs,
    backupRepo: state.backupRepo,
    grantedPermissions: state.grantedPermissions,
    oauthRequested: scopeRows(connection?.requestedScopes),
    oauthGranted: scopeRows(connection?.grantedScopes),
  };
}
