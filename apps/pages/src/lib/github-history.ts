import {
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * GitHub history helpers for the sealed-store capability.
 *
 * All GitHub calls go through Host (`/connections/{id}/github/repos`) so the
 * browser never sees provider tokens. Creating a repo defaults to **private**.
 */

import { hostFetch } from "./identity.js";

export const DEFAULT_PASSWORD_REPO_NAME = "opensesame-passwords";

export type GithubRepoSummary = {
  fullName: string;
  name: string;
  private: boolean;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
};

function toRepo(raw: JsonObject): GithubRepoSummary {
  return {
    fullName: String(raw.full_name ?? ""),
    name: String(raw.name ?? ""),
    private: Boolean(raw.private),
    cloneUrl: String(raw.clone_url ?? ""),
    htmlUrl: String(raw.html_url ?? ""),
    defaultBranch: String(raw.default_branch ?? "main"),
  };
}

function responseHint(body: JsonObject): string | undefined {
  if (isString(body.hint)) return body.hint;
  return isString(body.error) ? body.error : undefined;
}

async function listGithubReposDefault(
  connectionId: string,
): Promise<GithubRepoSummary[]> {
  const res = await hostFetch(
    `/api/v1/connections/${encodeURIComponent(connectionId)}/github/repos`,
  );
  if (!res.ok) {
    const body: JsonObject = overlapCast(await res.json().catch(() => ({})));
    throw new Error(
      responseHint(body) ?? `Could not list GitHub repos (${res.status})`,
    );
  }
  const body: JsonObject = overlapCast(await res.json());
  const rows = Array.isArray(body.repositories) ? body.repositories : [];
  return rows
    .filter((row): row is JsonObject => isJsonObject(row))
    .map(toRepo)
    .filter((repo) => repo.cloneUrl.startsWith("https://"));
}

async function createGithubPasswordRepoDefault(
  connectionId: string,
  options: {
    name?: string;
    /** Defaults to true — private password store. */
    private?: boolean;
    description?: string;
  } = {},
): Promise<GithubRepoSummary> {
  const res = await hostFetch(
    `/api/v1/connections/${encodeURIComponent(connectionId)}/github/repos`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: options.name?.trim() || DEFAULT_PASSWORD_REPO_NAME,
        private: options.private ?? true,
        description:
          options.description ??
          "OpenSesame sealed-store ciphertext (passwords) — private by default",
      }),
    },
  );
  if (!res.ok) {
    const body: JsonObject = overlapCast(await res.json().catch(() => ({})));
    throw new Error(
      responseHint(body) ?? `Could not create GitHub repo (${res.status})`,
    );
  }
  const raw: JsonObject = overlapCast(await res.json());
  const repo = toRepo(raw);
  if (!repo.cloneUrl.startsWith("https://")) {
    throw new Error("Host returned a repo without an https clone URL");
  }
  if ((options.private ?? true) && !repo.private) {
    throw new Error("Expected a private repository for password history");
  }
  return repo;
}

/** Pure helpers for UI/tests — default private password-store remote. */
export function defaultCreateRepoRequest(name = DEFAULT_PASSWORD_REPO_NAME) {
  return {
    name,
    private: true as const,
    description:
      "OpenSesame sealed-store ciphertext (passwords) — private by default",
  };
}

function remoteFromRepoDefault(repo: GithubRepoSummary): string {
  return repo.cloneUrl.replace(/\/$/, "");
}

export const githubHistorySeams = {
  listGithubRepos: listGithubReposDefault,
  createGithubPasswordRepo: createGithubPasswordRepoDefault,
  remoteFromRepo: remoteFromRepoDefault,
};

export async function listGithubRepos(
  connectionId: string,
): Promise<GithubRepoSummary[]> {
  return githubHistorySeams.listGithubRepos(connectionId);
}

export async function createGithubPasswordRepo(
  ...args: Parameters<typeof createGithubPasswordRepoDefault>
): Promise<GithubRepoSummary> {
  return githubHistorySeams.createGithubPasswordRepo(...args);
}

export function remoteFromRepo(repo: GithubRepoSummary): string {
  return githubHistorySeams.remoteFromRepo(repo);
}
