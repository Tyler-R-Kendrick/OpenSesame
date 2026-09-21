import { StatusMark } from "../../components/StatusMark.js";
import type { Connection } from "../../lib/connections.js";
import { BackupSyncControls } from "./BackupSyncControls.js";
import {
  GithubAppInstallRows,
  GithubAppPermissionBlock,
  GithubAppRepoList,
} from "./GithubAppConfigRows.js";
import { buildGithubAppSummaryModel } from "./githubAppSummaryModel.js";
import { useGithubAppPresence } from "./useGithubAppPresence.js";

/**
 * Read-only App configuration after install: name, registrant, install
 * accounts, granted permissions, backup repo. Unregister lives in the
 * connector title row.
 */
export function GithubAppConfigSummary({
  connection = null,
}: {
  connection?: Connection | null;
}) {
  const { localApp, state } = useGithubAppPresence();
  const view = buildGithubAppSummaryModel(localApp, state, connection);
  if (!view.visible) return null;

  return (
    <div className="conn-github-presence" data-testid="github-app-presence">
      <AppNameRow name={view.appName} htmlUrl={view.htmlUrl} />
      <OwnerRow
        ownerLogin={view.ownerLogin}
        ownerType={view.ownerType}
        ownerMissing={view.ownerMissing}
      />
      <GithubAppInstallRows installs={view.installs} />
      {view.backupRepo ? (
        <div className="conn-github-fact" data-testid="github-app-backup">
          <span className="conn-github-presence__k">Backup</span>
          <span>{view.backupRepo}</span>
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
