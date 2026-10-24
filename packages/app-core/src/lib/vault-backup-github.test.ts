/** @vitest-environment jsdom */
import { createItem } from "@opensesame/vault-core";
import { expect, it, vi } from "vitest";
import {
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { ensureDeviceIdentityKey } from "./device-identity-key.js";
import { useGithubBackupProviderFixture } from "./github-app-backup-provider.test-support.js";
import { createProject, setActiveProject } from "./projects.js";
import { restoreSavedGithubBackup } from "./vault-backup-github.js";
import { drainBackupWebhooks, syncVaultBackup } from "./vault-backup-sync.js";
import { VaultStore, vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";
const fixture = useGithubBackupProviderFixture();
it.each([40, 64])(
  "uses real default writes and %i-character provider poll IDs without exposing PEM",
  async (length) => {
    const result = await syncVaultBackup("github");
    expect(result?.lastCommitSha).toBe(fixture.head);
    expect(result?.status).toBe("ok");
    expect(fixture.contents?.toString()).not.toContain(
      "owned-direct-backup-encrypted-canary",
    );
    expect(JSON.stringify(fixture.requests)).not.toContain("PRIVATE KEY");
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "PUT",
      "GET",
    ]);
    expect(await drainBackupWebhooks()).toBe(0);
    fixture.head = "f".repeat(length);
    expect(await drainBackupWebhooks()).toBe(1);
    expect(
      fixture.requests.some((request) =>
        request.path.startsWith("/api/github-app/"),
      ),
    ).toBe(false);
  },
);
it("restores real provider ciphertext into another PIN vault and preserves its identity", async () => {
  await syncVaultBackup("github");
  const project = await createProject(`Direct restore ${crypto.randomUUID()}`);
  await setActiveProject(project.id);
  const destination = new VaultStore();
  fixture.destinations.push(destination);
  await destination.createWithPin("68391527");
  const kept = createItem("note", "Destination-only note");
  await destination.saveItem(kept);
  const identity = await ensureDeviceIdentityKey(
    destination.getSnapshot().tomb,
  );
  await expect(
    restoreSavedGithubBackup("github", "wrong source PIN", destination),
  ).rejects.toThrow();
  await restoreSavedGithubBackup("github", "83619472", destination);
  await destination.flushPendingWrites();
  await vfsFlush();
  destination.lock();
  await expect(destination.unlockWithPin("83619472")).rejects.toThrow();
  await destination.unlockWithPin("68391527");
  expect(destination.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: kept.id }),
      expect.objectContaining({ id: fixture.source.id }),
    ]),
  );
  expect(
    (await ensureDeviceIdentityKey(destination.getSnapshot().tomb)).keyId,
  ).toBe(identity.keyId);
});
it.each(["denied", "corrupt"])(
  "does not advance success/pending work for %s provider responses",
  async (refusal) => {
    fixture.mode = refusal;
    await expect(syncVaultBackup("github")).rejects.toThrow();
    const result = readLocalBackupTarget("github");
    expect(result?.status).toBe("error");
    expect(result?.lastCommitSha).toBeNull();
    expect(result?.pendingEvents).toBe(2);
  },
);
it("refuses policy withdrawal before credential egress", async () => {
  fixture.network.network.mockReturnValue({
    externalServices: "allow",
    allowedServiceOrigins: ["https://other.example"],
  });
  await expect(syncVaultBackup("github")).rejects.toThrow();
  expect(fixture.requests).toEqual([]);
});
it("retains a reconfigured target instead of publishing stale success or overwriting it on failure", async () => {
  fixture.onWrite = () => {
    const target = readLocalBackupTarget("github");
    if (target)
      writeLocalBackupTarget({ ...target, branch: "different-target" });
  };
  await expect(syncVaultBackup("github")).rejects.toThrow();
  expect(readLocalBackupTarget("github")).toMatchObject({
    branch: "different-target",
    status: "pending",
    pendingEvents: 2,
  });
});
it("holds the original direct fetch across provider awaits", async () => {
  const replacement = vi.fn(async () => {
    throw new Error("Must not adopt replacement transport");
  });
  fixture.onWrite = () => vi.stubGlobal("fetch", replacement);
  await expect(syncVaultBackup("github")).resolves.toMatchObject({
    status: "ok",
  });
  expect(replacement).not.toHaveBeenCalled();
});
it("does not record success when the original vault locks after the write", async () => {
  fixture.onWrite = () => vaultStore.lock();
  await expect(syncVaultBackup("github")).rejects.toThrow();
  expect(readLocalBackupTarget("github")).toMatchObject({
    status: "error",
    lastCommitSha: null,
    pendingEvents: 2,
  });
});

it.each([
  { label: "missing", body: {} },
  { label: "null", body: null },
  { label: "array", body: [] },
  { label: "abbreviated", body: { commit: { sha: "deadbeef" } } },
  { label: "null object", body: { commit: { sha: "0".repeat(40) } } },
])(
  "keeps previous success and pending work for an actual provider's $label confirmation",
  async ({ body }) => {
    const previous = readLocalBackupTarget("github");
    if (!previous) throw new Error("Missing fixture target");
    writeLocalBackupTarget({
      ...previous,
      status: "ok",
      lastCommitSha: "c".repeat(40),
      lastSyncedAt: "2026-10-23T12:00:00.000Z",
      pendingEvents: 3,
    });
    fixture.confirmation = () => body;
    await expect(syncVaultBackup("github")).rejects.toThrow();
    expect(fixture.requests.some((request) => request.method === "PUT")).toBe(
      true,
    );
    expect(readLocalBackupTarget("github")).toMatchObject({
      status: "error",
      lastCommitSha: "c".repeat(40),
      lastSyncedAt: "2026-10-23T12:00:00.000Z",
      pendingEvents: 3,
    });
    expect(readLocalBackupTarget("github")?.lastError).not.toContain(
      "PRIVATE KEY",
    );
  },
);

it.each([40, 64])(
  "refuses null %i-character provider poll IDs",
  async (length) => {
    await syncVaultBackup("github");
    const previous = readLocalBackupTarget("github");
    fixture.head = "0".repeat(length);
    await expect(drainBackupWebhooks()).rejects.toThrow();
    expect(readLocalBackupTarget("github")).toEqual(previous);
  },
);
