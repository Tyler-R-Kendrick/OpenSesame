/**
 * Pure helpers for the GitHub backup repository field.
 */
import {
  type BackupTargetView,
  ownerRepoFromRemote,
} from "../../lib/backup.js";
import type {
  AppInstallAccount,
  AppRepoSummary,
} from "../../lib/github-app-repos.js";

export type RepoChoice = {
  fullName: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
};

export type BackupSlugDecision =
  | { kind: "existing"; choice: RepoChoice }
  | { kind: "create"; account: AppInstallAccount; name: string }
  | { kind: "invalid"; message: string };

/** Resolve a typed slug against listed repos and install accounts. */
export function resolveBackupSlug(
  slug: string,
  repos: RepoChoice[],
  accounts: AppInstallAccount[],
): BackupSlugDecision {
  const known = existingRepo(
    slug,
    repos.map((repo) => repo.fullName),
  );
  if (known) {
    const choice = repos.find((repo) => repo.fullName === known);
    if (choice) return { kind: "existing", choice };
  }
  const parsed = ownerRepoFromRemote(slug);
  if (parsed) {
    const account = accounts.find(
      (row) => row.accountLogin.toLowerCase() === parsed.owner.toLowerCase(),
    );
    if (!account) {
      return {
        kind: "invalid",
        message:
          "Pick a repository under an account where the App is installed.",
      };
    }
    const name = repoNameFromSlug(parsed.repo);
    if (!name) {
      return { kind: "invalid", message: "Repository name is not valid." };
    }
    const needle = `${parsed.owner}/${name}`.toLowerCase();
    const exact = repos.find((repo) => repo.fullName.toLowerCase() === needle);
    if (exact) return { kind: "existing", choice: exact };
    return { kind: "create", account, name };
  }
  const name = repoNameFromSlug(slug);
  if (!name) {
    return { kind: "invalid", message: "Repository name is not valid." };
  }
  const account = accounts[0];
  if (!account) {
    return {
      kind: "invalid",
      message: "Install the GitHub App, then choose a repository.",
    };
  }
  return { kind: "create", account, name };
}

/** GitHub repository slugs: letters, numbers, `.`, `_`, `-`, and one `/`. */
export function sanitizeRepoSlug(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._/-]/gu, "");
  const slash = cleaned.indexOf("/");
  if (slash === -1) return cleanSegment(cleaned).slice(0, 100);
  const owner = cleanSegment(cleaned.slice(0, slash)).slice(0, 39);
  const repo = cleanSegment(cleaned.slice(slash + 1).replace(/\//gu, "")).slice(
    0,
    100,
  );
  return cleaned.endsWith("/") && repo === ""
    ? `${owner}/`
    : `${owner}/${repo}`;
}

export function repoNameFromSlug(slug: string): string | null {
  const name = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(name)) return null;
  if (name.endsWith(".") || name.toLowerCase().endsWith(".git")) return null;
  return name;
}

export function existingRepo(slug: string, repos: string[]): string | null {
  const needle = slug.trim().toLowerCase();
  if (!needle || needle.endsWith("/")) return null;
  const exact = repos.find((name) => name.toLowerCase() === needle);
  if (exact) return exact;
  if (needle.includes("/")) return null;
  const matches = repos.filter(
    (name) => name.split("/")[1]?.toLowerCase() === needle,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function isBound(target: BackupTargetView | null): boolean {
  return Boolean(target?.enabled && target.repo !== "");
}

function pushNamedRepos(
  rows: RepoChoice[],
  names: Array<{ fullName: string }>,
  accounts: AppInstallAccount[],
): void {
  const defaultAccount = accounts[0] ?? null;
  for (const item of names) {
    const key = item.fullName.toLowerCase();
    if (!item.fullName || rows.some((row) => row.fullName.toLowerCase() === key)) {
      continue;
    }
    const owner = item.fullName.split("/")[0] ?? "";
    const account =
      accounts.find(
        (row) => row.accountLogin.toLowerCase() === owner.toLowerCase(),
      ) ?? defaultAccount;
    if (!account) continue;
    rows.push({
      fullName: item.fullName,
      installationId: account.installationId,
      accountLogin: account.accountLogin,
      accountType: account.accountType,
    });
  }
}

export function mergeChoices(
  appRepos: AppRepoSummary[],
  hostRepos: Array<{ fullName: string }>,
  accounts: AppInstallAccount[],
  target: BackupTargetView | null,
  seedRepos: string[] = [],
): RepoChoice[] {
  const rows: RepoChoice[] = appRepos.map((repo) => ({
    fullName: repo.fullName,
    installationId: repo.installationId,
    accountLogin: repo.accountLogin,
    accountType: repo.accountType,
  }));
  pushNamedRepos(rows, hostRepos, accounts);
  pushNamedRepos(
    rows,
    seedRepos.map((fullName) => ({ fullName })),
    accounts,
  );
  if (target?.owner && target.repo && target.installationId) {
    const fullName = `${target.owner}/${target.repo}`;
    if (!rows.some((row) => row.fullName.toLowerCase() === fullName.toLowerCase())) {
      rows.push({
        fullName,
        installationId: target.installationId,
        accountLogin: target.owner,
        accountType: "",
      });
    }
  }
  return mergeChoiceRows(rows);
}

export function mergeChoiceRows(rows: RepoChoice[]): RepoChoice[] {
  const seen = new Set<string>();
  const out: RepoChoice[] = [];
  for (const row of rows) {
    const key = row.fullName.toLowerCase();
    if (!row.fullName || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function cleanSegment(value: string): string {
  return value.replace(/^[.-]+/u, "").replace(/\.git$/iu, "");
}
