import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backupSeams } from "./backup.js";
import { type Connection, connectionSeams } from "./connections.js";
import { githubHistorySeams } from "./github-history.js";
import {
  ensureGithubAccessGrant,
  loadGithubInstallationSnapshot,
  revokeGithubAccessGrant,
  shouldEnsureGithubAccessGrant,
} from "./github-installation-access.js";
import { localRequestFixture } from "./local-request.fixture.js";
import { listLocalShares } from "./local-share-grants.js";
import { lockAllTombs } from "./vfs.js";

const originalConnectionSeams = { ...connectionSeams };
const originalBackupSeams = { ...backupSeams };
const originalGithubHistorySeams = { ...githubHistorySeams };

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
  Object.assign(connectionSeams, originalConnectionSeams);
  Object.assign(backupSeams, originalBackupSeams);
  Object.assign(githubHistorySeams, originalGithubHistorySeams);
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads install identity, repos, and events for an active connection", async () => {
  const fixture = await localRequestFixture();
  const snapshot = await loadGithubInstallationSnapshot(
    fixture.tomb,
    baseConnection,
  );
  expect(snapshot.installations[0]?.accountLogin).toBe("octocat");
  expect(snapshot.repos.map((row) => row.fullName)).toEqual([
    "octocat/secrets",
  ]);
  expect(snapshot.events[0]?.kind).toBe("bound");
});

it("records a revocable Access grant and unbinds on revoke", async () => {
  const fixture = await localRequestFixture();
  const shares = await ensureGithubAccessGrant(fixture.tomb, baseConnection);
  expect(shares).toHaveLength(1);
  expect(shares[0]?.resourceId).toBe("github");
  expect(shares[0]?.policy).toBe("invoke");
  expect(bindConnection).toHaveBeenCalledWith(
    "con_gh",
    expect.objectContaining({
      targetKind: "identity",
      targetId: fixture.personId,
    }),
  );

  const shareId = shares[0]?.id ?? "";
  await revokeGithubAccessGrant(fixture.tomb, shareId, baseConnection);
  expect(await listLocalShares(fixture.tomb)).toEqual([]);
  expect(unbindConnection).toHaveBeenCalledWith("con_gh", "bind_1");

  const after = await loadGithubInstallationSnapshot(
    fixture.tomb,
    baseConnection,
  );
  expect(shouldEnsureGithubAccessGrant(after, baseConnection)).toBe(false);
  expect(after.auditEvents.map((event) => event.eventType)).toEqual(
    expect.arrayContaining([
      "access.connection.revoked",
      "connection.binding.unbound",
      "access.connection.granted",
      "connection.binding.bound",
    ]),
  );
  for (const event of after.auditEvents) {
    expect(JSON.stringify(event)).not.toMatch(/octocat|Owner|secrets/i);
  }
  expect(
    after.events.every(
      (event) => event.detail === null || event.detail === "identity",
    ),
  ).toBe(true);
});
