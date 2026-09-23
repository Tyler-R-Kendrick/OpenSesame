import type { Connection } from "@opensesame/app-core/lib/connections.js";
import type { AppInstallAccount } from "@opensesame/app-core/lib/github-app-repos.js";
import { buildGithubAppSummaryModel } from "@opensesame/app-core/sections/connections/githubAppSummaryModel.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { overlapCast } from "@opensesame/os-domain";
import { useMemo } from "react";
import { StatusMark } from "../../components/StatusMark.js";
import { BackupSyncControls } from "./BackupSyncControls.js";
import {
  GithubAppInstallRows,
  GithubAppPermissionBlock,
  GithubAppRepoList,
} from "./GithubAppConfigRows.js";
import { GithubBackupField } from "./GithubBackupRepo.js";
import { useGithubAppPresence } from "./useGithubAppPresence.js";

/** App-only bind path when no OAuth connection card is mounted. */
function localAppConnection(accountLabel: string | null): Connection {
  return overlapCast({
    connectionId: "local-github-app",
    connectionRef: "local-github-app",
    logicalName: "github",
    displayName: "GitHub",
    providerId: "github",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "local",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 1,
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    bindings: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  }) satisfies Connection;
}

/**
 * App configuration after install: name, registrant, installs, permissions,
 * repository bind/sync. Unregister lives in the connector title row.
 */
export function GithubAppConfigSummary({
  connection = null,
  online = true,
  onFlash,
  onReady,
}: {
  connection?: Connection | null;
  online?: boolean;
  onFlash?: (flash: Flash | null) => void;
  onReady?: (ready: boolean) => void;
}) {
  const { localApp, state } = useGithubAppPresence();
  const view = buildGithubAppSummaryModel(localApp, state, connection);
  const localConnection = useMemo(() => {
    if (localApp) {
      return localAppConnection(
        localApp.ownerLogin ?? localApp.installedByLogin,
      );
    }
    const install = state.installs[0];
    if (install) return localAppConnection(install.accountLogin);
    if (state.backupRepo) {
      const owner = state.backupRepo.split("/")[0] ?? null;
      return localAppConnection(owner);
    }
    return null;
  }, [localApp, state.installs, state.backupRepo]);
  const seedAccounts = useMemo<AppInstallAccount[]>(
    () =>
      state.installs.map((row) => ({
        installationId: row.id,
        accountLogin: row.accountLogin,
        accountType: row.accountType,
      })),
    [state.installs],
  );
  const seedRepos = useMemo(
    () => state.installs.flatMap((row) => row.repositories),
    [state.installs],
  );
  if (!view.visible) return null;
  const bindConnection = connection ?? localConnection;
  const flash =
    onFlash ??
    ((_next: Flash | null) => {
      /* Settings always passes onFlash; tests may omit it. */
    });

  return (
    <div className="conn-github-presence" data-testid="github-app-presence">
      <AppNameRow name={view.appName} htmlUrl={view.htmlUrl} />
      <OwnerRow
        ownerLogin={view.ownerLogin}
        ownerType={view.ownerType}
        ownerMissing={view.ownerMissing}
      />
      <GithubAppInstallRows installs={view.installs} />
      {bindConnection ? (
        <div className="conn-github-fact" data-testid="github-app-repository">
          <span className="conn-github-presence__k">Repository</span>
          <GithubBackupField
            connection={bindConnection}
            online={online}
            onFlash={flash}
            onReady={onReady}
            seedAccounts={seedAccounts}
            seedRepos={seedRepos}
          />
        </div>
      ) : null}
      <BackupSyncControls />
      <GithubAppPermissionBlock
        label="Granted"
        testId="github-app-granted"
        rows={view.grantedPermissions}
      />
      <GithubAppPermissionBlock
        label="OAuth asked"
        testId="github-app-oauth-requested"
        rows={view.oauthRequested}
      />
      <GithubAppPermissionBlock
        label="OAuth granted"
        testId="github-app-oauth-granted"
        rows={view.oauthGranted}
      />
      <GithubAppRepoList installs={view.installs} />
    </div>
  );
}

function AppNameRow({
  name,
  htmlUrl,
}: {
  name: string | null;
  htmlUrl: string | null;
}) {
  if (!name) return null;
  return (
    <div className="conn-github-fact" data-testid="github-app-name">
      <span className="conn-github-presence__k">App</span>
      {htmlUrl ? (
        <a href={htmlUrl} target="_blank" rel="noreferrer noopener">
          {name}
        </a>
      ) : (
        <span>{name}</span>
      )}
    </div>
  );
}

function OwnerRow({
  ownerLogin,
  ownerType,
  ownerMissing,
}: {
  ownerLogin: string | null;
  ownerType: string | null;
  ownerMissing: boolean;
}) {
  if (ownerLogin) {
    return (
      <div className="conn-github-fact" data-testid="github-app-owner">
        <span className="conn-github-presence__k">Registered</span>
        <span>
          {ownerLogin}
          {ownerType ? ` · ${ownerType}` : ""}
        </span>
      </div>
    );
  }
  if (!ownerMissing) return null;
  return (
    <div className="conn-github-fact" data-testid="github-app-owner-missing">
      <span className="conn-github-presence__k">Registered</span>
      <span className="conn-github-fact__warn">
        <StatusMark
          tone="warn"
          label="GitHub App registered; registrant not known yet"
        />
        unknown
      </span>
    </div>
  );
}
