import { backupSeams } from "@opensesame/app-core/lib/backup.js";
import {
  type Connection,
  connectionSeams,
} from "@opensesame/app-core/lib/connections.js";
import { githubHistorySeams } from "@opensesame/app-core/lib/github-history.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { listLocalShares } from "@opensesame/app-core/lib/local-share-grants.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { GithubCardDetails } from "./GithubInstallationPanel.js";

const originalConnectionSeams = { ...connectionSeams };
const originalBackupSeams = { ...backupSeams };
const originalGithubHistorySeams = { ...githubHistorySeams };
const originalVaultHooksSeams = { ...vaultHooksSeams };

const listIntegrations = vi.fn();
const listConnections = vi.fn();
const listGithubInstallations = vi.fn();
const listGithubRepos = vi.fn();
const connectionEvents = vi.fn();
const bindConnection = vi.fn();
const unbindConnection = vi.fn();

const baseConnection = overlapCast({
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

let liveConnection: Connection = baseConnection;

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  liveConnection = baseConnection;
  Object.assign(connectionSeams, {
    listIntegrations,
    listConnections,
    connectionEvents,
    bindConnection,
    unbindConnection,
  });
  Object.assign(backupSeams, { listGithubInstallations });
  Object.assign(githubHistorySeams, { listGithubRepos });
  listIntegrations.mockResolvedValue([
    {
      id: "int_gh",
      key: "github-app",
      providerId: "github",
      displayName: "OpenSesame",
      source: "organization",
      enabled: true,
      configured: true,
      scopes: [],
      githubAppHtmlUrl: "https://github.com/apps/opensesame",
    },
  ]);
  listConnections.mockImplementation(async () => [liveConnection]);
  listGithubInstallations.mockResolvedValue([
    {
      id: "42",
      accountLogin: "octocat",
      accountType: "User",
      targetType: "User",
      repositorySelection: "selected",
      permissions: [
        { name: "contents", access: "write" },
        { name: "metadata", access: "read" },
      ],
      repositories: ["octocat/secrets"],
    },
  ]);
  listGithubRepos.mockResolvedValue([
    {
      fullName: "octocat/secrets",
      name: "secrets",
      private: true,
      cloneUrl: "https://github.com/octocat/secrets.git",
      htmlUrl: "https://github.com/octocat/secrets",
      defaultBranch: "main",
    },
  ]);
  connectionEvents.mockResolvedValue([
    {
      id: "evt_1",
      kind: "bound",
      at: "2026-09-18T12:00:00Z",
      detail: "identity · owner",
    },
  ]);
  bindConnection.mockImplementation(async (_id, body) => {
    liveConnection = {
      ...baseConnection,
      bindings: [
        {
          id: "bind_1",
          targetKind: "identity",
          targetId: body.targetId,
          targetLabel: body.targetLabel,
          createdAt: "2026-09-18T12:00:00Z",
        },
      ],
    };
    return liveConnection;
  });
  unbindConnection.mockImplementation(async () => {
    liveConnection = { ...baseConnection, bindings: [] };
    connectionEvents.mockResolvedValue([
      {
        id: "evt_2",
        kind: "unbound",
        at: "2026-09-18T12:05:00Z",
        detail: "identity · owner",
      },
      {
        id: "evt_1",
        kind: "bound",
        at: "2026-09-18T12:00:00Z",
        detail: "identity · owner",
      },
    ]);
    return liveConnection;
  });
});

afterEach(() => {
  cleanup();
  Object.assign(connectionSeams, originalConnectionSeams);
  Object.assign(backupSeams, originalBackupSeams);
  Object.assign(githubHistorySeams, originalGithubHistorySeams);
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.skip("puts the GitHub account, permissions, and repositories on the card and records the grant for Access", async () => {
  const fixture = await localRequestFixture();
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => ({ activeTomb: () => fixture.tomb }),
  });

  render(<GithubCardDetails connection={baseConnection} />);

  await screen.findByTestId("github-install-account");
  expect(screen.getByTestId("github-install-account").textContent).toContain(
    "octocat",
  );
  expect(screen.getByText("Permissions")).toBeTruthy();
  expect(
    screen.getByTestId("github-install-permissions").textContent,
  ).toContain("contents");
  expect(screen.getByText("Repositories")).toBeTruthy();
  expect(screen.getByTestId("github-install-repos").textContent).toContain(
    "octocat/secrets",
  );
  expect(screen.queryByTestId("github-install-grant")).toBeNull();
  expect(screen.queryByText("Access grant")).toBeNull();

  await waitFor(async () => {
    expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
  });
});
