import { backupSeams } from "@opensesame/app-core/lib/backup.js";
import {
  type Connection,
  connectionSeams,
} from "@opensesame/app-core/lib/connections.js";
import { githubHistorySeams } from "@opensesame/app-core/lib/github-history.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import {
  listLocalShares,
  revokeLocalShare,
} from "@opensesame/app-core/lib/local-share-grants.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
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
const originalIdentitySeams = { ...identitySeams };

const listIntegrations = vi.fn();
const listConnections = vi.fn();
const listGithubInstallations = vi.fn();
const listGithubRepos = vi.fn();
/** Every request a Pages library could send a Host goes through this seam. */
const hostFetch = vi.fn(async () => new Response(null, { status: 599 }));

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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 599 })),
  );
  Object.assign(identitySeams, { hostFetch });
  Object.assign(connectionSeams, { listIntegrations, listConnections });
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
  listConnections.mockResolvedValue([baseConnection]);
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
});

afterEach(() => {
  cleanup();
  Object.assign(connectionSeams, originalConnectionSeams);
  Object.assign(backupSeams, originalBackupSeams);
  Object.assign(githubHistorySeams, originalGithubHistorySeams);
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
  Object.assign(identitySeams, originalIdentitySeams);
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("puts the GitHub account, permissions, and repositories on the card and records the grant for Access", async () => {
  const fixture = await localRequestFixture();
  // The card reads the open vault's tomb from `useVault()`; the grant it
  // records for Access lands in that tomb's share ledger.
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...vaultStore.getSnapshot(), tomb: fixture.tomb }),
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
  const [share] = await listLocalShares(fixture.tomb);
  expect(share).toMatchObject({
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "github",
    policy: "invoke",
  });
  // The grant is the local share alone: no Host binding, no Host request.
  expect(hostFetch).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not re-issue the grant after it was revoked in Access", async () => {
  const fixture = await localRequestFixture();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...vaultStore.getSnapshot(), tomb: fixture.tomb }),
  });

  const first = render(<GithubCardDetails connection={baseConnection} />);
  await waitFor(async () => {
    expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
  });
  first.unmount();

  const [share] = await listLocalShares(fixture.tomb);
  await revokeLocalShare(fixture.tomb, share?.id ?? "");
  expect(await listLocalShares(fixture.tomb)).toEqual([]);

  render(<GithubCardDetails connection={baseConnection} />);
  // The card draws its rows only after it has decided about the grant, so
  // once the account is on screen the decision was made: stay revoked.
  await screen.findByTestId("github-install-account");
  expect(await listLocalShares(fixture.tomb)).toEqual([]);
  expect(hostFetch).not.toHaveBeenCalled();
});
