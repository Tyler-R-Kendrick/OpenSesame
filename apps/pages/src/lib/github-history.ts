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

function toRepo(raw: Record<string, unknown>): GithubRepoSummary {
  return {
    fullName: String(raw.full_name ?? ""),
    name: String(raw.name ?? ""),
    private: Boolean(raw.private),
    cloneUrl: String(raw.clone_url ?? ""),
    htmlUrl: String(raw.html_url ?? ""),
    defaultBranch: String(raw.default_branch ?? "main"),
  };
}

export async function listGithubRepos(
  connectionId: string,
): Promise<GithubRepoSummary[]> {
  const res = await hostFetch(
    `/api/v1/connections/${encodeURIComponent(connectionId)}/github/repos`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      hint?: string;
      error?: string;
    };
    throw new Error(
      body.hint || body.error || `Could not list GitHub repos (${res.status})`,
    );
  }
  const body = (await res.json()) as { repositories?: unknown };
  const rows = Array.isArray(body.repositories) ? body.repositories : [];
  return rows
    .filter(
      (row): row is Record<string, unknown> => !!row && typeof row === "object",
    )
    .map(toRepo)
    .filter((repo) => repo.cloneUrl.startsWith("https://"));
}

export async function createGithubPasswordRepo(
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
    const body = (await res.json().catch(() => ({}))) as {
      hint?: string;
      error?: string;
    };
    throw new Error(
      body.hint || body.error || `Could not create GitHub repo (${res.status})`,
    );
  }
  const raw = (await res.json()) as Record<string, unknown>;
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

export function remoteFromRepo(repo: GithubRepoSummary): string {
  return repo.cloneUrl.replace(/\/$/, "");
}
