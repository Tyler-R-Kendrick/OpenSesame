/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backupSeams } from "../../lib/backup.js";
import type { Connection } from "../../lib/connections.js";
import {
  DEFAULT_PASSWORD_REPO_NAME,
  githubHistorySeams,
} from "../../lib/github-history.js";
import {
  GithubBackupField,
  existingRepo,
  repoNameFromSlug,
  sanitizeRepoSlug,
} from "./GithubBackupRepo.js";

const originalBackup = { ...backupSeams };
const originalHistory = { ...githubHistorySeams };

const getBackupStatus = vi.fn();
const listGithubInstallations = vi.fn();
const putBackupTarget = vi.fn();
const listGithubRepos = vi.fn();
const createGithubPasswordRepo = vi.fn();

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

const repo = {
  fullName: "octocat/secrets",
  name: "secrets",
  private: true,
  cloneUrl: "https://github.com/octocat/secrets.git",
  htmlUrl: "https://github.com/octocat/secrets",
  defaultBranch: "main",
};

beforeEach(() => {
  Object.assign(backupSeams, {
    getBackupStatus,
    listGithubInstallations,
    putBackupTarget,
  });
  Object.assign(githubHistorySeams, {
    listGithubRepos,
    createGithubPasswordRepo,
  });
  getBackupStatus.mockResolvedValue({ target: null, pendingEvents: 0 });
  listGithubInstallations.mockResolvedValue([
    {
      id: "99",
      accountLogin: "octocat",
      accountType: "User",
      targetType: "User",
      repositorySelection: "selected",
      permissions: [],
      repositories: ["octocat/secrets"],
    },
  ]);
  listGithubRepos.mockResolvedValue([repo]);
  putBackupTarget.mockImplementation(
    (input: {
      owner: string;
      repo: string;
      installationId: string;
      branch: string;
    }) =>
      Promise.resolve({
        integrationId: "int_gh",
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        enabled: true,
        status: "pending",
        lastCommitSha: null,
        lastSyncedAt: null,
        lastError: null,
      }),
  );
});

afterEach(() => {
  cleanup();
  Object.assign(backupSeams, originalBackup);
  Object.assign(githubHistorySeams, originalHistory);
});

it("shows the bound repository as a label", async () => {
  const onReady = vi.fn();
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
      onReady={onReady}
    />,
  );
  const shown = await screen.findByTestId("github-backup-repo");
  expect(shown.textContent).toContain("octocat/secrets");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByLabelText("Backup repository")).toBeNull();
  await waitFor(() => expect(onReady).toHaveBeenCalledWith(true));
  await userEvent.click(
    screen.getByRole("button", { name: "Edit repository" }),
  );
  expect(screen.getByLabelText("Backup repository")).toBeTruthy();
});

it("binds a slug that exists and creates one that does not", async () => {
  const onReady = vi.fn();
  createGithubPasswordRepo.mockResolvedValue({
    ...repo,
    fullName: "octocat/opensesame-passwords",
    name: "opensesame-passwords",
    cloneUrl: "https://github.com/octocat/opensesame-passwords.git",
  });
  render(
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      onReady={onReady}
    />,
  );
  const input = await screen.findByLabelText("Backup repository");
  expect(input).toHaveProperty("value", DEFAULT_PASSWORD_REPO_NAME);
  await waitFor(() =>
    expect(document.querySelector("option")?.getAttribute("value")).toBe(
      "octocat/secrets",
    ),
  );
  await waitFor(() => expect(onReady).toHaveBeenCalledWith(false));
  await userEvent.clear(input);
  await userEvent.type(input, "secrets{Enter}");
  await waitFor(() =>
    expect(putBackupTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "octocat",
        repo: "secrets",
        installationId: "99",
      }),
    ),
  );
  expect(
    (await screen.findByTestId("github-backup-repo")).textContent,
  ).toContain("octocat/secrets");
  expect(
    screen.queryByRole("button", { name: "Create repository" }),
  ).toBeNull();

  await userEvent.click(
    screen.getByRole("button", { name: "Edit repository" }),
  );
  const again = screen.getByLabelText("Backup repository");
  await userEvent.clear(again);
  await userEvent.type(again, "opensesame-passwords{Enter}");
  await waitFor(() =>
    expect(createGithubPasswordRepo).toHaveBeenCalledWith("con_gh", {
      name: "opensesame-passwords",
      private: true,
    }),
  );
});

it("creates the offered repository name when it is accepted", async () => {
  createGithubPasswordRepo.mockResolvedValue({
    ...repo,
    fullName: "octocat/opensesame-passwords",
    name: "opensesame-passwords",
    cloneUrl: "https://github.com/octocat/opensesame-passwords.git",
  });
  render(
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      onReady={vi.fn()}
    />,
  );
  const input = await screen.findByLabelText("Backup repository");
  expect(input).toHaveProperty("value", DEFAULT_PASSWORD_REPO_NAME);
  await waitFor(() => expect(document.querySelector("option")).toBeTruthy());
  await userEvent.type(input, "{Enter}");
  await waitFor(() =>
    expect(createGithubPasswordRepo).toHaveBeenCalledWith("con_gh", {
      name: DEFAULT_PASSWORD_REPO_NAME,
      private: true,
    }),
  );
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
});
