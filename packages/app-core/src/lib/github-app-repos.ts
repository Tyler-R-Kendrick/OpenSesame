/**
 * List / create GitHub repositories directly with the locally sealed App key.
 * Host OAuth listing remains a supplement when a connection exists.
 */
import {
  type JsonObject,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import { pemFromVault, readLocalGithubApp } from "./github-app-local.js";
import {
  type GithubRepositoryOutcome as RepositoryOutcome,
  directGithubAppRepositoryRequest,
} from "./github-app-repos-direct.js";

export type AppRepoSummary = {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
};

export type AppInstallAccount = {
  installationId: string;
  accountLogin: string;
  accountType: string;
};

function toRepo(
  raw: JsonObject,
  install: AppInstallAccount,
): AppRepoSummary | null {
  const fullName = readString(raw.fullName) ?? readString(raw.full_name) ?? "";
  const name = readString(raw.name) ?? "";
  if (!fullName || !name) return null;
  return {
    fullName,
    name,
    private: raw.private !== false,
    defaultBranch: readString(raw.defaultBranch) || "main",
    installationId: install.installationId,
    accountLogin: install.accountLogin,
    accountType: readString(raw.accountType) || install.accountType,
  };
}

type AppCredentials = {
  appId: string;
  pem: string;
  installs: AppInstallAccount[];
};

function credentialsDefault(): AppCredentials | null {
  const app = readLocalGithubApp();
  const pem = app ? pemFromVault(app) : null;
  if (!app?.id || !pem || app.installations.length === 0) return null;
  return {
    appId: app.id,
    pem,
    installs: app.installations.map((row) => ({
      installationId: row.id,
      accountLogin: row.accountLogin,
      accountType: row.accountType,
    })),
  };
}

export const githubAppRepoSeams = {
  credentials: credentialsDefault,
  /** Compatibility operation-port name; the default sends only direct GitHub REST. */
  postRelay: directGithubAppRepositoryRequest,
};

export type InstallationRepoList = {
  repositories: AppRepoSummary[];
  error: string | null;
};

/** Private repos visible to every local App installation. */
export async function listGithubAppInstallationRepos(): Promise<InstallationRepoList> {
  const creds = githubAppRepoSeams.credentials();
  if (!creds) {
    return {
      repositories: [],
      error: "Unlock the vault to list repositories for this App.",
    };
  }
  const { ok, payload }: RepositoryOutcome = await githubAppRepoSeams.postRelay(
    "/api/github-app/installation-repos",
    { appId: creds.appId, pem: creds.pem },
  );
  if (!ok)
    return {
      repositories: [],
      error:
        readString(payload.message) ||
        "Could not list repositories for the GitHub App install.",
    };
  const out: AppRepoSummary[] = [];
  const seen = new Set<string>();
  const error = readString(payload.error) ?? null;
  const rows = Array.isArray(payload.repositories) ? payload.repositories : [];
  for (const item of rows) {
    if (!isTypeofObject(item) || item === null) continue;
    const raw: JsonObject = overlapCast(item);
    const fullName =
      readString(raw.fullName) ?? readString(raw.full_name) ?? "";
    const install = creds.installs.find((row) =>
      isString(raw.installationId)
        ? row.installationId === raw.installationId
        : row.accountLogin.toLowerCase() ===
          fullName.split("/")[0]?.toLowerCase(),
    );
    if (!install) continue;
    const mapped = toRepo(raw, install);
    if (!mapped || !mapped.private) continue;
    const key = mapped.fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
  }
  return { repositories: out, error };
}

export async function createGithubAppRepo(input: {
  installationId: string;
  owner: string;
  name: string;
  accountType: string;
}): Promise<AppRepoSummary> {
  const creds = githubAppRepoSeams.credentials();
  if (!creds) {
    throw new Error("Unlock the vault and install the GitHub App first.");
  }
  const install =
    creds.installs.find((row) => row.installationId === input.installationId) ??
    null;
  if (!install) {
    throw new Error("That account has no GitHub App installation.");
  }
  const { ok, payload } = await githubAppRepoSeams.postRelay(
    "/api/github-app/create-repo",
    {
      appId: creds.appId,
      pem: creds.pem,
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
      accountType: input.accountType,
      private: true,
    },
  );
  if (!ok) {
    throw new Error(
      (isString(payload.message) ? payload.message : null) ||
        "Could not create the repository.",
    );
  }
  if (!isTypeofObject(payload.repository) || payload.repository === null) {
    throw new Error("Could not create the repository.");
  }
  const mapped = toRepo(overlapCast(payload.repository), install);
  if (!mapped) throw new Error("Could not create the repository.");
  return mapped;
}

export function listLocalAppInstallAccounts(): AppInstallAccount[] {
  const sealed = githubAppRepoSeams.credentials();
  if (sealed) return sealed.installs;
  // Public install rows still validate owner/repo without the PEM.
  const app = readLocalGithubApp();
  if (!app) return [];
  return app.installations.map((row) => ({
    installationId: row.id,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
  }));
}
