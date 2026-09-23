import { backupSeams } from "@opensesame/app-core/lib/backup.js";
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import {
  claimGithubAppCode,
  forgetLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppPresence } from "./GithubAppPresence.js";

const PUBLIC_KEY = "opensesame.github-app.public";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("GithubAppPresence", () => {
  const originalBackup = { ...backupSeams };
  const originalConnections = { ...connectionSeams };

  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => [
        {
          id: "4242",
          accountLogin: "acme-corp",
          accountType: "Organization",
          targetType: "Organization",
          repositorySelection: "selected",
          permissions: [
            { name: "contents", access: "write" },
            { name: "metadata", access: "read" },
          ],
          repositories: ["acme-corp/vault"],
        },
      ]),
      getBackupStatus: vi.fn(async () => ({
        target: {
          integrationId: "int-gh",
          installationId: "4242",
          owner: "acme-corp",
          repo: "vault",
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
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => [
        {
          id: "int-gh",
          key: "github-oauth",
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
  });

  afterEach(() => {
    cleanup();
    Object.assign(backupSeams, originalBackup);
    Object.assign(connectionSeams, originalConnections);
    vi.unstubAllGlobals();
  });

  it("shows Host install config: name, account, permissions, repository", async () => {
    render(<GithubAppPresence />);
    await waitFor(() => {
      expect(screen.getByTestId("github-app-install").textContent).toContain(
        "acme-corp",
      );
    });
    expect(screen.getByTestId("github-app-name").textContent).toContain(
      "OpenSesame",
    );
    expect(screen.getByTestId("github-app-install").textContent).toContain(
      "Organization",
    );
    expect(screen.getByTestId("github-app-install").textContent).toContain(
      "repos selected",
    );
    await waitFor(() => {
      expect(screen.getByTestId("github-backup-repo").textContent).toContain(
        "acme-corp/vault",
      );
    });
    expect(screen.getByTestId("github-app-granted").textContent).toContain(
      "contents",
    );
    expect(screen.getByTestId("github-app-repos").textContent).toContain(
      "acme-corp/vault",
    );
  });

  it("unlocks the repository field for editing", async () => {
    const onFlash = vi.fn();
    localStorage.setItem(
      PUBLIC_KEY,
      JSON.stringify({
        id: "123",
        key: "github-oauth",
        displayName: "OpenSesame",
        htmlUrl: "https://github.com/apps/opensesame",
        ownerLogin: "acme-corp",
        ownerType: "Organization",
        installedByLogin: null,
        installations: [
          {
            id: "4242",
            accountLogin: "acme-corp",
            accountType: "Organization",
          },
        ],
      }),
    );
    render(<GithubAppPresence online onFlash={onFlash} />);
    await waitFor(() => {
      expect(screen.getByTestId("github-backup-repo").textContent).toContain(
        "acme-corp/vault",
      );
    });
    expect(screen.queryByLabelText("Repository")).toBeNull();
    await userEvent.click(screen.getByTestId("github-repo-edit"));
    const input = await screen.findByTestId("github-repo-input");
    expect((input as HTMLInputElement).disabled).toBe(false);
  });

  it("shows local App registrant when stored", async () => {
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => []),
    });
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => []),
      getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    });
    localStorage.setItem(
      PUBLIC_KEY,
      JSON.stringify({
        id: "123",
        key: "github-oauth",
        displayName: "OpenSesame",
        htmlUrl: "https://github.com/apps/opensesame",
        ownerLogin: "Tyler-R-Kendrick",
        ownerType: "User",
        installedByLogin: null,
        installations: [
          {
            id: "999",
            accountLogin: "real-org",
            accountType: "Organization",
          },
        ],
      }),
    );
    render(<GithubAppPresence />);
    await waitFor(() => {
      expect(screen.getByTestId("github-app-owner").textContent).toContain(
        "Tyler-R-Kendrick",
      );
    });
    expect(screen.getByTestId("github-app-install").textContent).toContain(
      "real-org",
    );
  });
  it("shows the registrant when a guest claim finishes after empty mount", async () => {
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => []),
    });
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => []),
      getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    });
    render(<GithubAppPresence />);
    expect(screen.queryByTestId("github-app-presence")).toBeNull();

    sessionStorage.setItem("opensesame.github-app.state", "claim-state");
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      status: "unlocked",
      tomb: "guest",
      guest: true,
      header: null,
      items: [],
      folders: [],
      prefs: {
        autoLockMinutes: 0,
        lockOnHide: false,
        signOutOnLock: false,
        clipboardClearSeconds: 30,
        theme: "system",
      },
      lockedOutUntil: null,
      failedAttempts: 0,
      awaitingSecondStep: false,
      durable: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/api/github-app/convert")) {
          return Response.json({
            id: 4997182,
            client_id: "Iv1.example",
            name: "OpenSesame Local",
            html_url: "https://github.com/apps/opensesame-local",
            client_secret: "secret",
            pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
            ownerLogin: "Tyler-R-Kendrick",
            ownerType: "User",
          });
        }
        if (url.includes("/api/github-app/installations")) {
          return Response.json({
            ownerLogin: "Tyler-R-Kendrick",
            ownerType: "User",
            installations: [
              {
                id: "1",
                accountLogin: "Tyler-R-Kendrick",
                accountType: "User",
              },
            ],
          });
        }
        return Response.json({});
      }),
    );

    await expect(claimGithubAppCode("gh-code", "claim-state")).resolves.toBe(
      "registered",
    );
    await waitFor(() => {
      expect(screen.getByTestId("github-app-owner").textContent).toContain(
        "Tyler-R-Kendrick",
      );
    });
  });

  it("clears the registrant when Remove forgets the local App", async () => {
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => []),
    });
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => []),
      getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    });
    localStorage.setItem(
      PUBLIC_KEY,
      JSON.stringify({
        id: "4997182",
        key: "github-oauth",
        displayName: "OpenSesame Local",
        htmlUrl: "https://github.com/apps/opensesame-local",
        ownerLogin: "Tyler-R-Kendrick",
        ownerType: "User",
        installedByLogin: null,
        installations: [],
      }),
    );
    render(<GithubAppPresence />);
    await waitFor(() => {
      expect(screen.getByTestId("github-app-owner").textContent).toContain(
        "Tyler-R-Kendrick",
      );
    });
    // Forget control lives next to the connector title on SettingsPage.
    forgetLocalGithubApp();
    await waitFor(() => {
      expect(screen.queryByTestId("github-app-presence")).toBeNull();
    });
    expect(localStorage.getItem(PUBLIC_KEY)).toBeNull();
  });

  it("warns when the App is stored without a registrant", async () => {
    Object.assign(connectionSeams, {
      listIntegrations: vi.fn(async () => []),
    });
    Object.assign(backupSeams, {
      listGithubInstallations: vi.fn(async () => []),
      getBackupStatus: vi.fn(async () => ({ target: null, pendingEvents: 0 })),
    });
    localStorage.setItem(
      PUBLIC_KEY,
      JSON.stringify({
        id: "123",
        key: "github-oauth",
        displayName: "OpenSesame",
        htmlUrl: "https://github.com/apps/opensesame",
        ownerLogin: null,
        ownerType: null,
        installedByLogin: null,
        installations: [],
      }),
    );
    render(<GithubAppPresence />);
    await waitFor(() => {
      expect(
        screen.getByTestId("github-app-owner-missing").textContent,
      ).toContain("unknown");
    });
  });
});
