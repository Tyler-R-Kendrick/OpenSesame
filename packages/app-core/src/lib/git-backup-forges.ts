/**
 * Shared helpers for forge git backup remotes (GitLab, Bitbucket, Codeberg,
 * Cursor Origin, and the generic `git` connector).
 */

export const GIT_BACKUP_PROVIDER_IDS = [
  "gitlab",
  "bitbucket",
  "codeberg",
  "origin",
  "git",
] as const;

export type GitBackupProviderId = (typeof GIT_BACKUP_PROVIDER_IDS)[number];

export type GitBackupForge =
  | "gitlab"
  | "bitbucket"
  | "codeberg"
  | "origin"
  | "gitea";

export function isGitBackupProvider(id: string): boolean {
  for (const providerId of GIT_BACKUP_PROVIDER_IDS) {
    if (providerId === id) return true;
  }
  return false;
}

/** Map catalog provider id → forge API dialect used by the Connect relay. */
export function forgeForProvider(providerId: string): GitBackupForge | null {
  if (providerId === "gitlab") return "gitlab";
  if (providerId === "bitbucket") return "bitbucket";
  if (providerId === "codeberg") return "codeberg";
  if (providerId === "origin") return "origin";
  return null;
}

/**
 * Parse `owner/repo` from common HTTPS/SSH clone URLs for known forges.
 * Generic `git` remotes still work when the path is `owner/repo.git`.
 */
export function ownerRepoFromGitRemote(remote: string): {
  owner: string;
  repo: string;
} | null {
  const trimmed = remote
    .trim()
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
  const https = trimmed.match(
    /^https?:\/\/(?:www\.)?(?:gitlab\.com|bitbucket\.org|codeberg\.org|origin\.cursor\.com|cursor\.com)\/([^/]+)\/([^/]+)$/iu,
  );
  if (https?.[1] && https[2]) {
    return { owner: https[1], repo: https[2] };
  }
  const scp = trimmed.match(
    /^(?:git@)?(?:gitlab\.com|bitbucket\.org|codeberg\.org|origin\.cursor\.com)[:/]([^/]+)\/([^/]+)$/iu,
  );
  if (scp?.[1] && scp[2]) {
    return { owner: scp[1], repo: scp[2] };
  }
  const generic = trimmed.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)$/iu);
  if (generic?.[1] && generic[2]) {
    return { owner: generic[1], repo: generic[2] };
  }
  const slash = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/u);
  if (slash?.[1] && slash[2]) {
    return { owner: slash[1], repo: slash[2] };
  }
  return null;
}

/** Infer forge from a remote URL when the catalog id is generic `git`. */
export function forgeFromRemoteUrl(remote: string): GitBackupForge | null {
  const lower = remote.trim().toLowerCase();
  const https = lower.match(/^https?:\/\/(?:[^/@\s]*@)?([^/:?#\s]+)/u);
  const scp = https ? null : lower.match(/^(?:[^/@\s]*@)?([^:/\s]+):[^/]/u);
  const host = (https?.[1] ?? scp?.[1] ?? "").replace(/^www\./u, "");
  if (host === "gitlab.com") return "gitlab";
  if (host === "bitbucket.org") return "bitbucket";
  if (host === "codeberg.org") return "codeberg";
  if (host === "origin.cursor.com" || host === "cursor.com") return "origin";
  return null;
}
