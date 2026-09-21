import type { AppInstallAccount } from "../../lib/github-app-repos.js";
import { DEFAULT_PASSWORD_REPO_NAME } from "../../lib/github-history.js";
import {
  type RepoChoice,
  resolveBackupSlug,
} from "./GithubBackupRepoResolve.js";

export type RepoSuggestion = {
  kind: "existing" | "create";
  value: string;
  label: string;
};

/** `filter` empty shows the full list; `draft` drives the typed create option. */
export function buildRepoSuggestions(input: {
  draft: string;
  filter: string;
  repos: RepoChoice[];
  accounts: AppInstallAccount[];
  listError?: string | null;
}): RepoSuggestion[] {
  const needle = input.filter.trim().toLowerCase();
  const existing = input.repos
    .filter(
      (repo) => !needle || repo.fullName.toLowerCase().includes(needle),
    )
    .map((repo) => ({
      kind: "existing" as const,
      value: repo.fullName,
      label: repo.fullName,
    }));
  if (input.listError) return existing;
  const seen = new Set(existing.map((row) => row.value.toLowerCase()));
  const creates: RepoSuggestion[] = [];
  const decision = resolveBackupSlug(
    input.draft,
    input.repos,
    input.accounts,
  );
  if (decision.kind === "create") {
    const value = `${decision.account.accountLogin}/${decision.name}`;
    if (!seen.has(value.toLowerCase())) {
      creates.push({ kind: "create", value, label: `New · ${value}` });
      seen.add(value.toLowerCase());
    }
  }
  for (const account of input.accounts) {
    const value = `${account.accountLogin}/${DEFAULT_PASSWORD_REPO_NAME}`;
    if (seen.has(value.toLowerCase())) continue;
    if (needle && !value.toLowerCase().includes(needle)) continue;
    creates.push({ kind: "create", value, label: `New · ${value}` });
    seen.add(value.toLowerCase());
  }
  return [...existing, ...creates];
}
