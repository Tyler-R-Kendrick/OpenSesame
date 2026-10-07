import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createNodeHost } from "../node/host.js";
import { maybeLocalStore } from "../ports.js";
import { listLocalGitConnections } from "./connections-local-git.js";
import {
  forgetAllLocalGitRemotes,
  forgetLocalGitRemote,
  getLocalGitRemote,
  hasLocalGitRemotes,
  rememberLocalGitRemote,
} from "./git-remote-local.js";
import { kvFlush, kvForgetAll } from "./kv.js";
import { writeLastVaultId } from "./last-vault.js";
import { vaultStore } from "./vault/store.js";
import { PERSONAL_TOMB } from "./vfs.js";

const PASSWORD = "Git connector owner password";
let directory = "";
beforeEach(async () => {
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  directory = await mkdtemp(join(tmpdir(), "git-connector-owner-"));
  configureHost(createNodeHost({ stateDir: directory }));
  writeLastVaultId(PERSONAL_TOMB);
  vaultStore.rehydrate();
  await vaultStore.create(PASSWORD);
});
afterEach(async () => {
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  await rm(directory, { recursive: true, force: true });
});

const publicConfiguration = {
  remote_url: "git@forge.example:team/store.git",
  auth_mode: "ssh_agent" as const,
};

describe("git-remote-local", () => {
  it("stores owner metadata without credentials and synthesizes a connection", async () => {
    const remote = await rememberLocalGitRemote({
      displayName: "Work forge",
      configuration: publicConfiguration,
    });
    expect(remote.secretItemId).toBeNull();
    expect(hasLocalGitRemotes()).toBe(true);
    const connection = listLocalGitConnections()[0];
    expect(connection?.providerId).toBe("git");
    expect(connection?.accountLabel).toBe(publicConfiguration.remote_url);
    expect(connection?.displayName).toBe("Work forge");
    expect(await forgetLocalGitRemote(remote.id)).toBe(true);
    expect(hasLocalGitRemotes()).toBe(false);
  });

  it("serializes concurrent owner metadata operations without losing another remote", async () => {
    const [first, second] = await Promise.all([
      rememberLocalGitRemote({
        displayName: "First",
        configuration: publicConfiguration,
      }),
      rememberLocalGitRemote({
        displayName: "Second",
        configuration: publicConfiguration,
      }),
    ]);
    expect(getLocalGitRemote(first.id)?.displayName).toBe("First");
    expect(getLocalGitRemote(second.id)?.displayName).toBe("Second");
    const [, third] = await Promise.all([
      forgetLocalGitRemote(first.id),
      rememberLocalGitRemote({
        displayName: "Third",
        configuration: publicConfiguration,
      }),
    ]);
    expect(getLocalGitRemote(first.id)).toBeNull();
    expect(getLocalGitRemote(second.id)?.displayName).toBe("Second");
    expect(getLocalGitRemote(third.id)?.displayName).toBe("Third");
  });

  it("refuses metadata and secret writes without actual vault admission", async () => {
    vaultStore.lock();
    expect(hasLocalGitRemotes()).toBe(false);
    await expect(
      rememberLocalGitRemote({
        displayName: "Locked remote",
        configuration: publicConfiguration,
      }),
    ).rejects.toThrow(/Unlock/);
    await expect(
      rememberLocalGitRemote({
        displayName: "Token remote",
        configuration: {
          remote_url: "https://git.example/a.git",
          auth_mode: "https_token",
          token: "fixture-git-token",
        },
      }),
    ).rejects.toThrow(/Unlock/);
  });

  it("seals the credential in the actual vault and trashes it when forgotten", async () => {
    const token = "fixture-git-token";
    const remote = await rememberLocalGitRemote({
      displayName: "Token remote",
      configuration: {
        remote_url: "https://git.example/a.git",
        auth_mode: "https_token",
        token,
      },
    });
    expect(remote.secretItemId).toEqual(expect.any(String));
    const item = vaultStore
      .getSnapshot()
      .items.find((row) => row.id === remote.secretItemId);
    expect(item?.kind === "secret" && item.value).toBe(
      JSON.stringify({ token }),
    );
    expect(
      maybeLocalStore()?.getItem("opensesame.git-remotes.v1"),
    ).not.toContain(token);
    expect(await forgetLocalGitRemote(remote.id)).toBe(true);
    expect(
      vaultStore
        .getSnapshot()
        .items.find((row) => row.id === remote.secretItemId)?.deletedAt,
    ).toEqual(expect.any(String));
    expect(hasLocalGitRemotes()).toBe(false);
  });

  it("a guest may manage its own metadata without exposing or deleting member rows", async () => {
    const member = await rememberLocalGitRemote({
      displayName: "Member",
      configuration: publicConfiguration,
    });
    await vaultStore.flushPendingWrites();
    const memberTomb = vaultStore.activeTomb();
    vaultStore.lock();
    await vaultStore.createGuest({ resume: false });
    expect(getLocalGitRemote(member.id)).toBeNull();
    expect(await forgetLocalGitRemote(member.id)).toBe(false);
    const guest = await rememberLocalGitRemote({
      displayName: "Guest",
      configuration: publicConfiguration,
    });
    expect(getLocalGitRemote(guest.id)?.displayName).toBe("Guest");
    await forgetAllLocalGitRemotes();
    expect(hasLocalGitRemotes()).toBe(false);
    vaultStore.lock();
    writeLastVaultId(memberTomb);
    vaultStore.rehydrate();
    await vaultStore.unlock(PASSWORD);
    expect(getLocalGitRemote(member.id)?.displayName).toBe("Member");
    expect(getLocalGitRemote(guest.id)).toBeNull();
  });

  it("quarantines unbound legacy metadata without erasing it on owner writes", async () => {
    const legacy = {
      id: "git_local_legacy",
      displayName: "Legacy",
      remoteUrl: "https://git.example/old.git",
      authMode: "ssh_agent",
      username: null,
      secretItemId: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    maybeLocalStore()?.setItem(
      "opensesame.git-remotes.v1",
      JSON.stringify([legacy]),
    );
    expect(hasLocalGitRemotes()).toBe(false);
    await rememberLocalGitRemote({
      displayName: "Owner",
      configuration: publicConfiguration,
    });
    expect(getLocalGitRemote(legacy.id)).toBeNull();
    expect(maybeLocalStore()?.getItem("opensesame.git-remotes.v1")).toContain(
      legacy.id,
    );
    await forgetAllLocalGitRemotes();
    expect(maybeLocalStore()?.getItem("opensesame.git-remotes.v1")).toContain(
      legacy.id,
    );
  });

  it("preserves records from unknown schemas and refuses overwriting malformed storage", async () => {
    const store = maybeLocalStore();
    if (!store) throw new Error("The actual Node storage port is required.");
    const future = {
      schema: 9,
      owner: "other-vault",
      privateMetadata: "fixture-future-format",
    };
    store.setItem("opensesame.git-remotes.v1", JSON.stringify([future, null]));
    const own = await rememberLocalGitRemote({
      displayName: "Owner",
      configuration: publicConfiguration,
    });
    expect(
      JSON.parse(store.getItem("opensesame.git-remotes.v1") ?? "[]"),
    ).toContainEqual(future);
    await forgetLocalGitRemote(own.id);
    expect(
      JSON.parse(store.getItem("opensesame.git-remotes.v1") ?? "[]"),
    ).toEqual([future, null]);
    store.setItem("opensesame.git-remotes.v1", "malformed fixture record");
    await expect(
      rememberLocalGitRemote({
        displayName: "Denied",
        configuration: publicConfiguration,
      }),
    ).rejects.toThrow(/unreadable/);
    expect(store.getItem("opensesame.git-remotes.v1")).toBe(
      "malformed fixture record",
    );
  });

  it.each(["password", "pin"] as const)(
    "carries only the enrolling guest's metadata and sealed credential through %s enrollment",
    async (method) => {
      vaultStore.lock();
      await vaultStore.createGuest({ resume: false });
      const guest = await rememberLocalGitRemote({
        displayName: "Guest's own remote",
        configuration: {
          remote_url: "https://guest.example/own.git",
          auth_mode: "https_token",
          token: "guest-fixture-token",
        },
      });
      if (method === "password") await vaultStore.enrollPassword(PASSWORD);
      else await vaultStore.enrollPin("48629175");
      expect(vaultStore.getSnapshot().guest).toBe(false);
      expect(getLocalGitRemote(guest.id)?.secretItemId).toBe(
        guest.secretItemId,
      );
      await vaultStore.flushPendingWrites();
      vaultStore.lock();
      expect(getLocalGitRemote(guest.id)).toBeNull();
      vaultStore.rehydrate();
      if (method === "password") await vaultStore.unlock(PASSWORD);
      else await vaultStore.unlockWithPin("48629175");
      expect(getLocalGitRemote(guest.id)?.displayName).toBe(
        "Guest's own remote",
      );
      expect(
        vaultStore
          .getSnapshot()
          .items.some(
            (item) =>
              item.id === guest.secretItemId &&
              item.kind === "secret" &&
              item.value === '{"token":"guest-fixture-token"}',
          ),
      ).toBe(true);
    },
  );
});
