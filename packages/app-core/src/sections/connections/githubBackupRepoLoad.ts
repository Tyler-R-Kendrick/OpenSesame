import {
  type BackupTargetView,
  filterPrivateGithubRepos,
  getBackupStatus,
} from "../../lib/backup.js";
import type { Connection } from "../../lib/connections.js";
import { refreshGithubAppInstallations } from "../../lib/github-app-manifest.js";
import {
  type AppInstallAccount,
  listGithubAppInstallationRepos,
  listLocalAppInstallAccounts,
} from "../../lib/github-app-repos.js";
import {
  DEFAULT_PASSWORD_REPO_NAME,
  listGithubRepos,
} from "../../lib/github-history.js";
import { type RepoChoice, mergeChoices } from "./GithubBackupRepoResolve.js";

export function seedKey(rows: AppInstallAccount[]): string {
  return rows
    .map((row) => `${row.installationId}:${row.accountLogin}`)
    .join("|");
}

export function seedReposKey(names: string[]): string {
  return names.map((name) => name.toLowerCase()).join("|");
}

function mergeAccounts(
  primary: AppInstallAccount[],
  seed: AppInstallAccount[],
): AppInstallAccount[] {
  const out: AppInstallAccount[] = [];
  const seen = new Set<string>();
  for (const row of [...primary, ...seed]) {
    const key = row.installationId || row.accountLogin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export async function loadRepoChoices(
  connection: Connection,
  seedAccounts: AppInstallAccount[],
  seedRepos: string[],
  previousTarget: BackupTargetView | null,
) {
  await refreshGithubAppInstallations().catch(() => null);
  let statusError: string | null = null;
  const status = await getBackupStatus("github").catch(() => {
    statusError = "Could not load the backup target.";
    return null;
  });
  const target = status ? (status.target ?? null) : previousTarget;
  const accounts = mergeAccounts(listLocalAppInstallAccounts(), seedAccounts);
  const listed = await listGithubAppInstallationRepos().catch(() => ({
    repositories: [],
    error: "Could not list repositories for the GitHub App install.",
  }));
  let hostError: string | null = null;
  let hostRepos: Array<{ fullName: string }> = [];
  if (
    connection.connectionId !== "local-github-app" &&
    connection.status === "active"
  ) {
    try {
      hostRepos = filterPrivateGithubRepos(
        await listGithubRepos(connection.connectionId),
      );
    } catch {
      hostError = "Could not list repositories from the GitHub connection.";
    }
  }
  const repos = mergeChoices(
    listed.repositories,
    hostRepos,
    accounts,
    target,
    seedRepos,
  );
  let draft = DEFAULT_PASSWORD_REPO_NAME;
  if (target) draft = `${target.owner}/${target.repo}`;
  else if (accounts[0]) {
    draft = `${accounts[0].accountLogin}/${DEFAULT_PASSWORD_REPO_NAME}`;
  }
  const listError = listed.error ?? hostError ?? statusError;
  return {
    target,
    accounts,
    repos,
    draft,
    listError,
  };
}
