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

  it("returns Host install accounts for the connector page", async () => {
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
          githubAppHtmlUrl: null,
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
          permissions: [],
          repositories: [],
        },
      ]),
    });
    const state = await loadGithubAppPresenceState("");
    expect(state.installs).toEqual([
      {
        id: "55",
        accountLogin: "ship-it-org",
        accountType: "Organization",
      },
    ]);
  });
});
