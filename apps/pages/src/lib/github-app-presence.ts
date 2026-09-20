/**
 * Connector-page presence: App registrant + authenticated install accounts.
 * Host list when available; otherwise the local App JWT via the Connect relay.
 */
import {
  installationIdFromLocation,
  listGithubInstallations,
} from "./backup.js";
import { listIntegrations } from "./connections.js";
import {
  type LocalGithubApp,
  type LocalGithubInstall,
  readLocalGithubApp,
  refreshGithubAppInstallations,
  sealPendingGithubAppPem,
} from "./github-app-manifest.js";

export type GithubAppPresenceState = {
  ownerLogin: string | null;
  ownerType: string | null;
  /** Accounts the App is installed on (org or user) — the authenticated installs. */
  installs: LocalGithubInstall[];
};

function mergeInstall(
  into: Map<string, LocalGithubInstall>,
  row: LocalGithubInstall,
): void {
  if (row.id === "" || row.accountLogin === "") return;
  into.set(row.id, row);
}

/** Load registrant + live install accounts for the GitHub connector page. */
export async function loadGithubAppPresenceState(
  search = globalThis.location?.search ?? "",
): Promise<GithubAppPresenceState> {
  await sealPendingGithubAppPem();
  const highlighted = installationIdFromLocation(search);
  const local = await refreshGithubAppInstallations(readLocalGithubApp());
  const byId = new Map<string, LocalGithubInstall>();
  for (const row of local?.installations ?? []) {
    mergeInstall(byId, row);
  }

  const integrations = await listIntegrations().catch(() => []);
  for (const integration of integrations) {
    if (integration.providerId !== "github") continue;
    if (!integration.enabled || !integration.configured) continue;
    const rows = await listGithubInstallations(integration.id).catch(() => []);
    for (const row of rows) {
      mergeInstall(byId, {
        id: row.id,
        accountLogin: row.accountLogin,
        accountType: row.accountType || row.targetType || "",
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

  return {
    ownerLogin: local?.ownerLogin ?? null,
    ownerType: local?.ownerType ?? null,
    installs,
  };
}

export function presenceFromLocal(
  app: LocalGithubApp | null,
): GithubAppPresenceState {
  if (!app) {
    return { ownerLogin: null, ownerType: null, installs: [] };
  }
  return {
    ownerLogin: app.ownerLogin,
    ownerType: app.ownerType,
    installs: app.installations,
  };
}
