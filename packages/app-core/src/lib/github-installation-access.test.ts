import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backupSeams } from "./backup.js";
import { type Connection, connectionSeams } from "./connections.js";
import {
  ensureGithubAccessGrant,
  loadGithubInstallationSnapshot,
  shouldEnsureGithubAccessGrant,
} from "./github-installation-access.js";
import { identitySeams } from "./identity.js";
import { localRequestFixture } from "./local-request.fixture.js";
import {
  approvePendingShare,
  submitLocalShare,
} from "./local-share-grants-approvals.js";
import type {
  CreateLocalShareInput,
  LocalShare,
} from "./local-share-grants.js";
import { listLocalShares, revokeLocalShare } from "./local-share-grants.js";
import { lockAllTombs, writeFile } from "./vfs.js";

const originalConnectionSeams = { ...connectionSeams };
const originalBackupSeams = { ...backupSeams };
const originalIdentitySeams = { ...identitySeams };

const listIntegrations = vi.fn();
const listConnections = vi.fn();
const listGithubInstallations = vi.fn();
/** Every Host request a Pages library could make goes through this seam. */
const hostFetch = vi.fn(async () => new Response(null, { status: 599 }));

async function grantApplicationShare(
  tomb: string,
  input: CreateLocalShareInput,
): Promise<LocalShare[]> {
  const submitted = await submitLocalShare(tomb, input);
  if (submitted.outcome !== "pending") {
    throw new Error("expected an application grant to need approval");
  }
  return approvePendingShare(tomb, submitted.pending.id);
}

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

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  hostFetch.mockClear();
  Object.assign(identitySeams, { hostFetch });
  Object.assign(connectionSeams, { listIntegrations, listConnections });
  Object.assign(backupSeams, { listGithubInstallations });
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
  listConnections.mockResolvedValue([baseConnection]);
  listGithubInstallations.mockResolvedValue([
    {
      id: "42",
      accountLogin: "octocat",
      accountType: "User",
      targetType: "User",
    },
  ]);
});

afterEach(() => {
  Object.assign(connectionSeams, originalConnectionSeams);
  Object.assign(backupSeams, originalBackupSeams);
  Object.assign(identitySeams, originalIdentitySeams);
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads install identity for an active connection", async () => {
  const fixture = await localRequestFixture();
  const snapshot = await loadGithubInstallationSnapshot(
    fixture.tomb,
    baseConnection,
  );
  expect(snapshot.installations[0]?.accountLogin).toBe("octocat");
  expect(snapshot.shares).toEqual([]);
});

it("records the standing grant as a local connection share and writes no Host binding", async () => {
  const fixture = await localRequestFixture();
  const shares = await ensureGithubAccessGrant(fixture.tomb, baseConnection);
  expect(shares).toHaveLength(1);
  expect(shares[0]).toMatchObject({
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "github",
    policy: "invoke",
  });
  // ADR 0128: Pages keeps no Host grant machinery — the share is the grant.
  expect(hostFetch).not.toHaveBeenCalled();

  const after = await loadGithubInstallationSnapshot(
    fixture.tomb,
    baseConnection,
  );
  expect(shouldEnsureGithubAccessGrant(after, baseConnection)).toBe(false);
  expect(after.auditEvents.map((event) => event.eventType)).toEqual([
    "access.connection.granted",
  ]);
  for (const event of after.auditEvents) {
    expect(JSON.stringify(event)).not.toMatch(/octocat|Owner|secrets/i);
  }
});

it("revoking the grant in Access removes the share and the card does not re-issue it", async () => {
  const fixture = await localRequestFixture();
  const [share] = await ensureGithubAccessGrant(fixture.tomb, baseConnection);
  if (!share) throw new Error("expected a GitHub share");

  // Access › Grants and the connector's own panel revoke through this one call.
  await revokeLocalShare(fixture.tomb, share.id);
  expect(await listLocalShares(fixture.tomb)).toEqual([]);

  const after = await loadGithubInstallationSnapshot(
    fixture.tomb,
    baseConnection,
  );
  expect(after.auditEvents[0]).toMatchObject({
    eventType: "access.connection.revoked",
    targetType: "connection",
    targetId: "github",
  });
  expect(shouldEnsureGithubAccessGrant(after, baseConnection)).toBe(false);
  expect(hostFetch).not.toHaveBeenCalled();
});

it("an unreadable trail is answered as revoked: the card does not issue the grant", async () => {
  const fixture = await localRequestFixture();
  await writeFile(
    fixture.tomb,
    "config/access-audit",
    new TextEncoder().encode(JSON.stringify({ version: 2, events: "?" })),
  );
  const snapshot = await loadGithubInstallationSnapshot(
    fixture.tomb,
    baseConnection,
  );
  expect(snapshot.auditReadable).toBe(false);
  expect(shouldEnsureGithubAccessGrant(snapshot, baseConnection)).toBe(false);
});

it("a first visit with a live connection and no history issues the grant", async () => {
  const fixture = await localRequestFixture();
  const snapshot = await loadGithubInstallationSnapshot(
    fixture.tomb,
    baseConnection,
  );
  expect(shouldEnsureGithubAccessGrant(snapshot, baseConnection)).toBe(true);
});

it("someone else's GitHub revocation does not withhold the owner's grant", async () => {
  const fixture = await localRequestFixture();
  const [other] = await grantApplicationShare(fixture.tomb, {
    principalId: fixture.applicationId,
    resourceKind: "connection",
    resourceId: "github",
    resourceLabel: "GitHub",
    policy: "invoke",
    durationSeconds: 86400,
  });
  if (!other) throw new Error("expected a GitHub share");
  await revokeLocalShare(fixture.tomb, other.id);

  const snapshot = await loadGithubInstallationSnapshot(
    fixture.tomb,
    baseConnection,
  );
  expect(snapshot.ownerId).toBe(fixture.personId);
  expect(shouldEnsureGithubAccessGrant(snapshot, baseConnection)).toBe(true);
});

it("the owner's revocation holds however others are granted after it", async () => {
  const fixture = await localRequestFixture();
  const [share] = await ensureGithubAccessGrant(fixture.tomb, baseConnection);
  if (!share) throw new Error("expected a GitHub share");
  await revokeLocalShare(fixture.tomb, share.id);
  await grantApplicationShare(fixture.tomb, {
    principalId: fixture.applicationId,
    resourceKind: "connection",
    resourceId: "github",
    resourceLabel: "GitHub",
    policy: "invoke",
    durationSeconds: 86400,
  });

  const snapshot = await loadGithubInstallationSnapshot(
    fixture.tomb,
    baseConnection,
  );
  expect(shouldEnsureGithubAccessGrant(snapshot, baseConnection)).toBe(false);
});
