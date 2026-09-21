/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backupSeams } from "../../lib/backup.js";
import type { Connection } from "../../lib/connections.js";
import { githubAppRepoSeams } from "../../lib/github-app-repos.js";
import {
  DEFAULT_PASSWORD_REPO_NAME,
  githubHistorySeams,
} from "../../lib/github-history.js";
import {
  GithubBackupField,
  existingRepo,
  repoNameFromSlug,
  resolveBackupSlug,
  sanitizeRepoSlug,
} from "./GithubBackupRepo.js";

const originalBackup = { ...backupSeams };
const originalHistory = { ...githubHistorySeams };
const originalAppRepos = { ...githubAppRepoSeams };

const getBackupStatus = vi.fn();
const putBackupTarget = vi.fn();
const listGithubRepos = vi.fn();
const createGithubPasswordRepo = vi.fn();
const postRelay = vi.fn();

const connection = overlapCast({
  connectionId: "con_gh",
  connectionRef: "connref_gh",
  logicalName: "github",
  displayName: "GitHub",
  providerId: "github",
  integrationId: "int_gh",
  status: "active",
  statusDetail: null,
  organizationId: "org_1",
  projectId: null,
  ownerKind: "user",
  shareability: "private",
  requestedScopes: [],
  grantedScopes: [],
  accountLabel: "octocat",
  expiresAt: null,
  refreshable: false,
  lastRefreshedAt: null,
  maxInvokeLevel: 1,
  egress: {
    scheme: "https",
    authorities: ["api.github.com"],
    pathPrefixes: [],
  },
  bindings: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}) satisfies Connection;

beforeEach(() => {
  Object.assign(backupSeams, { getBackupStatus, putBackupTarget });
  Object.assign(githubHistorySeams, {
    listGithubRepos,
    createGithubPasswordRepo,
  });
  Object.assign(githubAppRepoSeams, {
    credentials: () => ({
      appId: "1",
      pem: "PEM",
      installs: [
        {
          installationId: "99",
          accountLogin: "octocat",
          accountType: "User",
        },
      ],
    }),
    postRelay,
  });
  getBackupStatus.mockResolvedValue({ target: null, pendingEvents: 0 });
  listGithubRepos.mockResolvedValue([]);
  putBackupTarget.mockImplementation(async (body: {
    owner: string;
    repo: string;
  }) => ({
    integrationId: "int_gh",
    installationId: "99",
    owner: body.owner,
    repo: body.repo,
    branch: "main",
    enabled: true,
    status: "ok",
    lastCommitSha: null,
    lastSyncedAt: null,
    lastError: null,
  }));
  postRelay.mockImplementation(async (path: string, body?: { name?: string }) => {
    if (path === "/api/github-app/installation-repos") {
      return {
        ok: true,
        status: 200,
        payload: {
          repositories: [
            {
              fullName: "octocat/secrets",
              name: "secrets",
              private: true,
              defaultBranch: "main",
            },
            {
              fullName: "octocat/vault",
              name: "vault",
              private: true,
              defaultBranch: "main",
            },
          ],
        },
      };
    }
    const name = body?.name ?? DEFAULT_PASSWORD_REPO_NAME;
    return {
      ok: true,
      status: 200,
      payload: {
        repository: {
          fullName: `octocat/${name}`,
          name,
          private: true,
          defaultBranch: "main",
        },
      },
    };
  });
});

afterEach(() => {
  cleanup();
  Object.assign(backupSeams, originalBackup);
  Object.assign(githubHistorySeams, originalHistory);
  Object.assign(githubAppRepoSeams, originalAppRepos);
});

it("lists existing repositories in the combobox", async () => {
  render(
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      onReady={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByTestId("github-repo-toggle"));
  await waitFor(() => {
    const list = screen.getByTestId("github-repo-list");
    expect(list.textContent).toContain("octocat/secrets");
    expect(list.textContent).toContain("octocat/vault");
  });
});

it("binds a repository chosen from the list", async () => {
  render(
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      onReady={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByTestId("github-repo-toggle"));
  await waitFor(() =>
    expect(screen.getByTestId("github-repo-list").textContent).toContain(
      "octocat/secrets",
    ),
  );
  await userEvent.click(screen.getByRole("option", { name: "octocat/secrets" }));
  await waitFor(() =>
    expect(putBackupTarget).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "octocat", repo: "secrets" }),
    ),
  );
  await waitFor(() =>
    expect(screen.getByTestId("github-backup-repo").textContent).toContain(
      "octocat/secrets",
    ),
  );
});

it("creates a typed repository name in the same field", async () => {
  render(
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      onReady={vi.fn()}
    />,
  );
  const input = await screen.findByTestId("github-repo-input");
  await userEvent.clear(input);
  await userEvent.type(input, "octocat/my-backup");
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(postRelay).toHaveBeenCalledWith(
      "/api/github-app/create-repo",
      expect.objectContaining({ name: "my-backup" }),
    ),
  );
  await waitFor(() =>
    expect(putBackupTarget).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "octocat", repo: "my-backup" }),
    ),
  );
});

it("seeds install repositories when the App list is empty", async () => {
  postRelay.mockResolvedValue({
    ok: true,
    status: 200,
    payload: { repositories: [] },
  });
  render(
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      seedAccounts={[
        {
          installationId: "99",
          accountLogin: "octocat",
          accountType: "User",
        },
      ]}
      seedRepos={["octocat/from-install"]}
    />,
  );
  await userEvent.click(await screen.findByTestId("github-repo-toggle"));
  await waitFor(() =>
    expect(screen.getByTestId("github-repo-list").textContent).toContain(
      "octocat/from-install",
    ),
  );
});


it("opens the bound repository for editing", async () => {
  getBackupStatus.mockResolvedValue({
    target: {
      integrationId: "int_gh",
      installationId: "99",
      owner: "octocat",
      repo: "secrets",
      branch: "main",
      enabled: true,
      status: "ok",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
    },
    pendingEvents: 0,
  });
  render(
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      onReady={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("github-backup-repo").textContent).toContain(
      "octocat/secrets",
    ),
  );
  await userEvent.click(screen.getByTestId("github-repo-edit"));
  expect(await screen.findByTestId("github-repo-input")).toBeTruthy();
});

it("keeps only characters a repository name can hold", () => {
  expect(sanitizeRepoSlug("bad name!")).toBe("badname");
  expect(sanitizeRepoSlug(".hidden")).toBe("hidden");
  expect(sanitizeRepoSlug("octocat/my repo.git")).toBe("octocat/myrepo");
  expect(repoNameFromSlug("octocat/secrets")).toBe("secrets");
  expect(repoNameFromSlug("trailing.git")).toBeNull();
  expect(existingRepo("secrets", ["octocat/secrets", "hub/other"])).toBe(
    "octocat/secrets",
  );
  expect(existingRepo("missing", ["octocat/secrets"])).toBeNull();
  expect(
    resolveBackupSlug(
      "evil/not-mine",
      [],
      [{ installationId: "1", accountLogin: "octocat", accountType: "User" }],
    ).kind,
  ).toBe("invalid");
});
