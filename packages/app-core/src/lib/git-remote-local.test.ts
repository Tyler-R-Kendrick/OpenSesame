/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listLocalGitConnections,
  revokeLocalGitConnection,
} from "./connections-local-git.js";
import {
  forgetAllLocalGitRemotes,
  forgetLocalGitRemote,
  getLocalGitRemote,
  hasLocalGitRemotes,
  rememberLocalGitRemote,
} from "./git-remote-local.js";
import {
  bindHistoryConnection,
  loadHistorySelections,
  toggleHistoryProvider,
} from "./history-backups.js";
import { vaultStore } from "./vault/store.js";

afterEach(async () => {
  vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(true);
  vi.spyOn(vaultStore, "trashItem").mockResolvedValue(undefined);
  await forgetAllLocalGitRemotes();
  vi.restoreAllMocks();
});

describe("git-remote-local", () => {
  it("stores public remote metadata without secrets and synthesizes a connection", async () => {
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(false);

    const remote = await rememberLocalGitRemote({
      displayName: "Work forge",
      configuration: {
        remote_url: "git@forge.example:team/store.git",
        auth_mode: "ssh_agent",
      },
    });

    expect(remote.secretItemId).toBeNull();
    expect(hasLocalGitRemotes()).toBe(true);
    const connection = listLocalGitConnections()[0];
    expect(connection?.providerId).toBe("git");
    expect(connection?.accountLabel).toBe("git@forge.example:team/store.git");
    expect(connection?.displayName).toBe("Work forge");
    expect(await forgetLocalGitRemote(remote.id)).toBe(true);
    expect(hasLocalGitRemotes()).toBe(false);
  });

  it("refuses to seal credentials when the vault is locked", async () => {
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(false);
    await expect(
      rememberLocalGitRemote({
        displayName: "Token remote",
        configuration: {
          remote_url: "https://git.example/a.git",
          auth_mode: "https_token",
          token: "glpat-secret",
        },
      }),
    ).rejects.toThrow(/Unlock the vault/);
  });

  it("trashes the sealed secret when forgetting an unlocked remote", async () => {
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(true);
    const trashItem = vi
      .spyOn(vaultStore, "trashItem")
      .mockResolvedValue(undefined);
    vi.spyOn(vaultStore, "addItems").mockImplementation(async (items) => {
      expect(items).toHaveLength(1);
      return undefined;
    });

    const remote = await rememberLocalGitRemote({
      displayName: "Token remote",
      configuration: {
        remote_url: "https://git.example/a.git",
        auth_mode: "https_token",
        token: "glpat-secret",
      },
    });
    expect(remote.secretItemId).toEqual(expect.any(String));
    expect(await forgetLocalGitRemote(remote.id)).toBe(true);
    expect(trashItem).toHaveBeenCalledWith(remote.secretItemId);
    expect(hasLocalGitRemotes()).toBe(false);
  });

  it("refuses to forget a sealed remote while the vault is locked", async () => {
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(true);
    vi.spyOn(vaultStore, "addItems").mockResolvedValue(undefined);
    const remote = await rememberLocalGitRemote({
      displayName: "Token remote",
      configuration: {
        remote_url: "https://git.example/a.git",
        auth_mode: "https_token",
        token: "glpat-secret",
      },
    });
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(false);
    await expect(forgetLocalGitRemote(remote.id)).rejects.toThrow(
      /Unlock the vault/,
    );
    expect(hasLocalGitRemotes()).toBe(true);
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(true);
    vi.spyOn(vaultStore, "trashItem").mockResolvedValue(undefined);
    await forgetLocalGitRemote(remote.id);
  });

  it("revokes the remote and its history binding together", async () => {
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(false);
    const remote = await rememberLocalGitRemote({
      displayName: "Work forge",
      configuration: {
        remote_url: "git@forge.example:team/store.git",
        auth_mode: "ssh_agent",
      },
    });
    await toggleHistoryProvider("github");
    bindHistoryConnection("github", remote.id);
    expect(
      loadHistorySelections().find((row) => row.providerId === "github")
        ?.connectionId,
    ).toBe(remote.id);

    expect(await revokeLocalGitConnection(remote.id)).toEqual({
      revoked: true,
      providerRevocation: "unsupported",
    });
    expect(getLocalGitRemote(remote.id)).toBeNull();
    expect(
      loadHistorySelections().find((row) => row.providerId === "github")
        ?.connectionId,
    ).toBeUndefined();
  });
});
