/**
 * Connector-page presence: App registrant, installs, permissions, backup.
 * Host list when available; otherwise the local App JWT via the Connect relay.
 */
import { maybePage } from "../ports.js";
import {
  type GithubAppPermission,
  getBackupStatus,
  installationIdFromLocation,
  listGithubInstallations,
} from "./backup.js";
import { listIntegrations } from "./connections.js";
import {
  GITHUB_APP_REQUESTED_PERMISSIONS,
  type LocalGithubApp,
  type LocalGithubInstall,
  readLocalGithubApp,
  refreshGithubAppInstallations,
  sealPendingGithubAppPem,
} from "./github-app-manifest.js";

export type GithubAppInstallView = {
  id: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string | null;
  permissions: GithubAppPermission[];
  repositories: string[];
};

export type GithubAppPresenceState = {
  appName: string | null;
  htmlUrl: string | null;
  ownerLogin: string | null;
  ownerType: string | null;
  /** Accounts the App is installed on (org or user). */
  installs: GithubAppInstallView[];
  requestedPermissions: GithubAppPermission[];
  grantedPermissions: GithubAppPermission[];
  /** Bound backup `owner/repo`, when configured. */
  backupRepo: string | null;
};

function fromLocalInstall(row: LocalGithubInstall): GithubAppInstallView {
  return {
    id: row.id,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: null,
    permissions: [],
    repositories: [],
  };
}

function mergeInstall(
  into: Map<string, GithubAppInstallView>,
  row: GithubAppInstallView,
): void {
  if (row.id === "" || row.accountLogin === "") return;
  const previous = into.get(row.id);
  if (!previous) {
    into.set(row.id, row);
    return;
  }
  into.set(row.id, {
    id: row.id,
    accountLogin: row.accountLogin || previous.accountLogin,
    accountType: row.accountType || previous.accountType,
    repositorySelection:
      row.repositorySelection ?? previous.repositorySelection,
    permissions:
      row.permissions.length > 0 ? row.permissions : previous.permissions,
    repositories:
      row.repositories.length > 0 ? row.repositories : previous.repositories,
  });
}

function uniquePermissions(rows: GithubAppPermission[]): GithubAppPermission[] {
  const byName = new Map<string, GithubAppPermission>();
  for (const row of rows) {
    if (row.name === "") continue;
    byName.set(row.name, row);
  }
  return [...byName.values()];
}

function requestedPermissions(): GithubAppPermission[] {
  return GITHUB_APP_REQUESTED_PERMISSIONS.map((row) => ({
    name: row.name,
    access: row.access,
  }));
}

/** Load registrant + live install accounts for the GitHub connector page. */
export async function loadGithubAppPresenceState(
  search = maybePage()?.location.search ?? "",
): Promise<GithubAppPresenceState> {
  await sealPendingGithubAppPem();
  const highlighted = installationIdFromLocation(search);
  const local = await refreshGithubAppInstallations(readLocalGithubApp());
  const byId = new Map<string, GithubAppInstallView>();
  for (const row of local?.installations ?? []) {
    mergeInstall(byId, fromLocalInstall(row));
  }

  let appName = local?.displayName ?? null;
  let htmlUrl = local?.htmlUrl ?? null;

  const integrations = await listIntegrations().catch(() => []);
  for (const integration of integrations) {
    if (integration.providerId !== "github") continue;
    if (!integration.enabled || !integration.configured) continue;
    if (!appName) appName = integration.displayName;
    if (!htmlUrl && integration.githubAppHtmlUrl) {
      htmlUrl = integration.githubAppHtmlUrl;
    }
    const rows = await listGithubInstallations(integration.id).catch(() => []);
    for (const row of rows) {
      mergeInstall(byId, {
        id: row.id,
        accountLogin: row.accountLogin,
        accountType: row.accountType || row.targetType || "",
        repositorySelection: row.repositorySelection || null,
        permissions: row.permissions,
        repositories: row.repositories,
      });
    }
  }

  let installs = [...byId.values()];
  if (highlighted) {
    const hit = installs.find((row) => row.id === highlighted);
    if (hit) {
      installs = [hit, ...installs.filter((row) => row.id !== highlighted)];
    }
  }

  const backup = await getBackupStatus("github").catch(() => null);
  const target = backup?.target;
  const backupRepo =
    target && target.owner !== "" && target.repo !== ""
      ? `${target.owner}/${target.repo}`
      : null;

  return {
    appName,
    htmlUrl,
    ownerLogin: local?.ownerLogin ?? null,
    ownerType: local?.ownerType ?? null,
    installs,
    requestedPermissions: requestedPermissions(),
    grantedPermissions: uniquePermissions(
      installs.flatMap((row) => row.permissions),
    ),
    backupRepo,
  };
}

export function presenceFromLocal(
  app: LocalGithubApp | null,
): GithubAppPresenceState {
  if (!app) {
    return {
      appName: null,
      htmlUrl: null,
      ownerLogin: null,
      ownerType: null,
      installs: [],
      requestedPermissions: requestedPermissions(),
      grantedPermissions: [],
      backupRepo: null,
    };
  }
  return {
    appName: app.displayName,
    htmlUrl: app.htmlUrl,
    ownerLogin: app.ownerLogin,
    ownerType: app.ownerType,
    installs: app.installations.map(fromLocalInstall),
    requestedPermissions: requestedPermissions(),
    grantedPermissions: [],
    backupRepo: null,
  };
}
