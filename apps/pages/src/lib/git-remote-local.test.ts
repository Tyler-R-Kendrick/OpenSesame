/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { listLocalGitConnections } from "./connections-local-git.js";
import {
  forgetAllLocalGitRemotes,
  forgetLocalGitRemote,
  hasLocalGitRemotes,
  rememberLocalGitRemote,
} from "./git-remote-local.js";
import { vaultStore } from "./vault/store.js";

afterEach(async () => {
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
});
