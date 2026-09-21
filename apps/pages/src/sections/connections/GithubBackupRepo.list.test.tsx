/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backupSeams } from "../../lib/backup.js";
import type { Connection } from "../../lib/connections.js";
import { githubAppRepoSeams } from "../../lib/github-app-repos.js";
import { githubHistorySeams } from "../../lib/github-history.js";
import { GithubBackupField } from "./GithubBackupRepo.js";

const originalBackup = { ...backupSeams };
const originalHistory = { ...githubHistorySeams };
const originalAppRepos = { ...githubAppRepoSeams };

const getBackupStatus = vi.fn();
const putBackupTarget = vi.fn();
const listGithubRepos = vi.fn();
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
    createGithubPasswordRepo: vi.fn(),
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
  putBackupTarget.mockImplementation(
    async (body: {
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
    }),
  );
  postRelay.mockResolvedValue({
    ok: true,
    status: 200,
    payload: { repositories: [] },
  });
});

afterEach(() => {
  cleanup();
  Object.assign(backupSeams, originalBackup);
  Object.assign(githubHistorySeams, originalHistory);
  Object.assign(githubAppRepoSeams, originalAppRepos);
});

it("opens the full install list when the field is cleared", async () => {
  const repositories = Array.from({ length: 120 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(3, "0")}`;
    return {
      fullName: `octocat/${name}`,
      name,
      private: true,
      defaultBranch: "main",
    };
  });
  postRelay.mockImplementation(async (path: string) => {
    if (path === "/api/github-app/installation-repos") {
      return { ok: true, status: 200, payload: { repositories } };
    }
    return {
      ok: true,
      status: 200,
      payload: {
        repository: {
          fullName: "octocat/password-store",
          name: "password-store",
          private: true,
          defaultBranch: "main",
        },
      },
    };
  });
  render(
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      onReady={vi.fn()}
    />,
  );
  const input = await screen.findByTestId("github-repo-input");
  await waitFor(() => expect(postRelay).toHaveBeenCalled());
  await userEvent.clear(input);
  // Escape closes any typing session; Show then opens the unfiltered list.
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByTestId("github-repo-toggle"));
  await waitFor(() => {
    const list = screen.getByTestId("github-repo-list");
    expect(
      list.querySelectorAll('[role="option"]').length,
    ).toBeGreaterThanOrEqual(120);
    expect(list.textContent).toContain("octocat/repo-001");
    expect(list.textContent).toContain("octocat/repo-120");
  });
});

it("filters the open list as characters are typed", async () => {
  postRelay.mockImplementation(async (path: string) => {
    if (path === "/api/github-app/installation-repos") {
      return {
        ok: true,
        status: 200,
        payload: {
          repositories: [
            {
              fullName: "octocat/alpha",
              name: "alpha",
              private: true,
              defaultBranch: "main",
            },
            {
              fullName: "octocat/vault-backup",
              name: "vault-backup",
              private: true,
              defaultBranch: "main",
            },
            {
              fullName: "octocat/vault-notes",
              name: "vault-notes",
              private: true,
              defaultBranch: "main",
            },
            {
              fullName: "octocat/zeta",
              name: "zeta",
              private: true,
              defaultBranch: "main",
            },
          ],
        },
      };
    }
    return {
      ok: true,
      status: 200,
      payload: {
        repository: {
          fullName: "octocat/password-store",
          name: "password-store",
          private: true,
          defaultBranch: "main",
        },
      },
    };
  });
  render(
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      onReady={vi.fn()}
    />,
  );
  const input = await screen.findByTestId("github-repo-input");
  await waitFor(() => expect(postRelay).toHaveBeenCalled());
  await userEvent.clear(input);
  await userEvent.type(input, "vault");
  const list = await screen.findByTestId("github-repo-list");
  await waitFor(() => {
    expect(list.textContent).toContain("octocat/vault-backup");
    expect(list.textContent).toContain("octocat/vault-notes");
  });
  expect(list.textContent).not.toContain("octocat/alpha");
  expect(list.textContent).not.toContain("octocat/zeta");
});

it("marks a list failure instead of showing an empty success", async () => {
  postRelay.mockResolvedValue({
    ok: false,
    status: 403,
    payload: { message: "Resource not accessible by integration" },
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
    expect(
      screen.getByLabelText("Resource not accessible by integration"),
    ).toBeTruthy(),
  );
  await userEvent.click(screen.getByTestId("github-repo-toggle"));
  const list = await screen.findByTestId("github-repo-list");
  expect(list.textContent).toContain("Repositories unavailable");
  expect(list.querySelectorAll('[role="option"]')).toHaveLength(0);
});
