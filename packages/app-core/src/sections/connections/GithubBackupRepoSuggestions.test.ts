/**
 * Ideal repository combobox behavior.
 *
 * Opening the list with an empty filter shows every private install repo.
 * Typing narrows that list by substring on owner/name. A novel valid slug
 * under an install account still offers create. An empty filter must never
 * hide a large install list behind the typed default draft.
 */
import { describe, expect, it } from "vitest";
import type { RepoChoice } from "./GithubBackupRepoResolve.js";
import { buildRepoSuggestions } from "./GithubBackupRepoSuggestions.js";

const ACCOUNT = {
  installationId: "99",
  accountLogin: "octocat",
  accountType: "User",
};

function manyRepos(count: number): RepoChoice[] {
  return Array.from({ length: count }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(3, "0")}`;
    return {
      fullName: `octocat/${name}`,
      installationId: "99",
      accountLogin: "octocat",
      accountType: "User",
    };
  });
}

describe("buildRepoSuggestions — ideal combobox", () => {
  it("shows every loaded repository when the filter is empty", () => {
    const repos = manyRepos(120);
    const rows = buildRepoSuggestions({
      draft: "octocat/password-store",
      filter: "",
      repos,
      accounts: [ACCOUNT],
    });
    const existing = rows.filter((row) => row.kind === "existing");
    expect(existing).toHaveLength(120);
    expect(existing[0]?.value).toBe("octocat/repo-001");
    expect(existing[119]?.value).toBe("octocat/repo-120");
  });

  it("narrows the open list as the person types characters", () => {
    const repos = [
      ...manyRepos(100),
      {
        fullName: "octocat/vault-backup",
        installationId: "99",
        accountLogin: "octocat",
        accountType: "User",
      },
      {
        fullName: "octocat/vault-notes",
        installationId: "99",
        accountLogin: "octocat",
        accountType: "User",
      },
      {
        fullName: "octocat/secrets",
        installationId: "99",
        accountLogin: "octocat",
        accountType: "User",
      },
    ];
    const rows = buildRepoSuggestions({
      draft: "octocat/vault",
      filter: "vault",
      repos,
      accounts: [ACCOUNT],
    });
    const existing = rows.filter((row) => row.kind === "existing");
    expect(existing.map((row) => row.value)).toEqual([
      "octocat/vault-backup",
      "octocat/vault-notes",
    ]);
  });

  it("matches typed owner/repo fragments against the full name", () => {
    const repos = manyRepos(50).concat({
      fullName: "acme/payments",
      installationId: "88",
      accountLogin: "acme",
      accountType: "Organization",
    });
    const rows = buildRepoSuggestions({
      draft: "acme/pay",
      filter: "acme/pay",
      repos,
      accounts: [
        ACCOUNT,
        {
          installationId: "88",
          accountLogin: "acme",
          accountType: "Organization",
        },
      ],
    });
    expect(
      rows.filter((row) => row.kind === "existing").map((r) => r.value),
    ).toEqual(["acme/payments"]);
  });

  it("offers create for a novel valid slug under an install account", () => {
    const rows = buildRepoSuggestions({
      draft: "octocat/brand-new-backup",
      filter: "octocat/brand-new-backup",
      repos: manyRepos(100),
      accounts: [ACCOUNT],
    });
    expect(rows.some((row) => row.kind === "existing")).toBe(false);
    expect(rows).toContainEqual({
      kind: "create",
      value: "octocat/brand-new-backup",
      label: "New · octocat/brand-new-backup",
    });
  });

  it("keeps matching existing repos ahead of the create option", () => {
    const repos = [
      {
        fullName: "octocat/vault",
        installationId: "99",
        accountLogin: "octocat",
        accountType: "User",
      },
    ];
    const rows = buildRepoSuggestions({
      draft: "octocat/vault",
      filter: "octocat/vault",
      repos,
      accounts: [ACCOUNT],
    });
    expect(rows.map((row) => row.kind)).toEqual(["existing"]);
    expect(rows[0]?.value).toBe("octocat/vault");
  });

  it("does not invent repos under accounts where the App is not installed", () => {
    const rows = buildRepoSuggestions({
      draft: "stranger/not-mine",
      filter: "stranger/not-mine",
      repos: manyRepos(10),
      accounts: [ACCOUNT],
    });
    expect(rows.filter((row) => row.kind === "create")).toEqual([]);
    expect(rows.filter((row) => row.kind === "existing")).toEqual([]);
  });
});

it("hides create rows when the install list failed", () => {
  const rows = buildRepoSuggestions({
    draft: "octocat/brand-new-backup",
    filter: "",
    repos: [],
    accounts: [ACCOUNT],
    listError: "Resource not accessible by integration",
  });
  expect(rows).toEqual([]);
});
