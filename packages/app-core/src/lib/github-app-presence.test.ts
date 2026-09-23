import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupSeams } from "./backup.js";
import { connectionSeams } from "./connections.js";
import { loadGithubAppPresenceState } from "./github-app-presence.js";

describe("loadGithubAppPresenceState", () => {
  const originalBackup = { ...backupSeams };
  const originalConnections = { ...connectionSeams };

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });
  });

  afterEach(() => {
    Object.assign(backupSeams, originalBackup);
    Object.assign(connectionSeams, originalConnections);
    vi.unstubAllGlobals();
  });

  it("returns Host install accounts, permissions, and backup for the connector page", async () => {
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => [
        {
          id: "int-1",
          key: "github",
          providerId: "github",
          displayName: "OpenSesame",
          source: "organization",
          enabled: true,
          configured: true,
          scopes: [],
          githubAppHtmlUrl: "https://github.com/apps/opensesame",
        },
      ]),
    });
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => [
        {
          id: "55",
          accountLogin: "ship-it-org",
          accountType: "Organization",
          targetType: "Organization",
          repositorySelection: "all",
          permissions: [
            { name: "contents", access: "write" },
            { name: "metadata", access: "read" },
          ],
          repositories: ["ship-it-org/passwords"],
        },
      ]),
      getBackupStatus: vi.fn(async () => ({
        target: {
          integrationId: "int-1",
          installationId: "55",
          owner: "ship-it-org",
          repo: "passwords",
          branch: "main",
          enabled: true,
          status: "ok",
          lastCommitSha: null,
          lastSyncedAt: null,
          lastError: null,
        },
        pendingEvents: 0,
      })),
    });
    const state = await loadGithubAppPresenceState("");
    expect(state.appName).toBe("OpenSesame");
    expect(state.htmlUrl).toBe("https://github.com/apps/opensesame");
    expect(state.backupRepo).toBe("ship-it-org/passwords");
    expect(state.installs).toEqual([
      {
        id: "55",
        accountLogin: "ship-it-org",
        accountType: "Organization",
        repositorySelection: "all",
        permissions: [
          { name: "contents", access: "write" },
          { name: "metadata", access: "read" },
        ],
        repositories: ["ship-it-org/passwords"],
      },
    ]);
    expect(state.grantedPermissions).toEqual([
      { name: "contents", access: "write" },
      { name: "metadata", access: "read" },
    ]);
    expect(state.requestedPermissions.map((row) => row.name)).toContain(
      "contents",
    );
  });
});
