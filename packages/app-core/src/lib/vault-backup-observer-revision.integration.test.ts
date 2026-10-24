/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readLocalBackupTarget } from "./backup-target-local.js";
import { resyncBackup } from "./backup.js";
import { useGithubBackupProviderFixture } from "./github-app-backup-provider.test-support.js";
import { createProject, setActiveProject } from "./projects.js";
import {
  readSavedGithubBackup,
  restoreSavedGithubBackup,
} from "./vault-backup-github.js";
import {
  startVaultBackupObserver,
  stopVaultBackupObserver,
} from "./vault-backup-observer.js";
import { vaultBackupSyncSeams } from "./vault-backup-sync.js";
import { VaultStore, vaultStore } from "./vault/store.js";
import { BODY_PATH, readSealedFile, tombFileKey, vfsSeams } from "./vfs.js";

const fixture = useGithubBackupProviderFixture();
beforeEach(stopVaultBackupObserver);
afterEach(stopVaultBackupObserver);

function puts() {
  return fixture.requests.filter((row) => row.method === "PUT");
}
function bodyMark() {
  const mark = readSealedFile(vaultStore.getSnapshot().tomb, BODY_PATH)?.ivB64;
  if (!mark) throw new Error("Missing persisted source body");
  return mark;
}
async function editSecret(value: string) {
  const before = vaultStore.getSnapshot();
  const item = before.items.find((row) => row.id === fixture.source.id);
  if (item?.kind !== "secret") throw new Error("Missing source secret");
  await vaultStore.saveItem({ ...item, value });
  expect(vaultStore.getSnapshot().items).toHaveLength(before.items.length);
  expect(vaultStore.getSnapshot().folders).toHaveLength(before.folders.length);
  return bodyMark();
}
async function confirmed(count: number) {
  // Observe actual transport confirmations; do not dispatch or advance the poll timer.
  await vi.waitFor(() => {
    expect(puts()).toHaveLength(count);
    expect(
      fixture.outcomes
        .filter((row) => row.method === "PUT")
        .map((row) => row.status),
    ).toEqual(Array(count).fill(201));
    expect(readLocalBackupTarget("github")).toMatchObject({
      status: "ok",
      lastCommitSha: fixture.head,
      pendingEvents: 0,
    });
  });
}
async function initialize() {
  await resyncBackup("github");
  await confirmed(1);
  expect(readLocalBackupTarget("github")?.lastSyncedAt).not.toBeNull();
  // Finish the observer's genuine initial read before introducing any mutation.
  // This only observes/delegates the default port; no poll result is supplied.
  const originalDrain = vaultBackupSyncSeams.drainWebhookPending;
  let resolved = (_count: number) => {};
  let rejected = (_error: Error) => {};
  const initialPoll = new Promise<number>((resolve, reject) => {
    resolved = resolve;
    rejected = reject;
  });
  const poll = vi
    .spyOn(vaultBackupSyncSeams, "drainWebhookPending")
    .mockImplementation(async () => {
      try {
        const count = await originalDrain();
        resolved(count);
        return count;
      } catch (error) {
        const failure =
          error instanceof Error
            ? error
            : new Error("The initial backup poll failed.", { cause: error });
        rejected(failure);
        throw failure;
      }
    });
  try {
    startVaultBackupObserver();
    expect(await initialPoll).toBe(0);
  } finally {
    poll.mockRestore();
  }
}
async function restoreAndCheck(value: string) {
  const project = await createProject(
    `Observed revision ${crypto.randomUUID()}`,
  );
  await setActiveProject(project.id);
  const destination = new VaultStore();
  fixture.destinations.push(destination);
  await destination.createWithPin("68391527");
  await restoreSavedGithubBackup("github", "83619472", destination);
  await destination.flushPendingWrites();
  destination.lock();
  await expect(destination.unlockWithPin("83619472")).rejects.toThrow();
  await destination.unlockWithPin("68391527");
  expect(destination.getSnapshot().items).toContainEqual(
    expect.objectContaining({ id: fixture.source.id, kind: "secret", value }),
  );
  expect(fixture.contents?.toString()).not.toContain(value);
  expect(JSON.stringify(fixture.requests)).not.toContain("PRIVATE KEY");
}
async function readUnchangedProvider(text: string) {
  const read = await readSavedGithubBackup("github");
  try {
    expect(read.text).toBe(text);
  } finally {
    read.close();
  }
}

it("automatically backs up a same-count secret edit and restores its actual value with another PIN", async () => {
  await initialize();
  const previous = fixture.head;
  const mark = await editSecret("same-count-secret-edited-canary");
  await confirmed(2);
  expect(fixture.head).not.toBe(previous);
  expect(
    JSON.parse(fixture.contents?.toString() ?? "null").vault.body.ivB64,
  ).toBe(mark);
  await restoreAndCheck("same-count-secret-edited-canary");
});

it("queues a second committed edit while the first actual PUT is held, without joining the older ciphertext", async () => {
  await initialize();
  const original = fixture.contents?.toString();
  if (!original) throw new Error("Missing real initial backup");
  const held = fixture.holdNextWrite();
  try {
    const first = await editSecret("held-first-revision-canary");
    await held.arrived;
    const second = await editSecret("held-second-revision-canary");
    expect(second).not.toBe(first);
    // Genuine independent read roundtrips progress while the first PUT is held.
    await readUnchangedProvider(original);
    expect(puts()).toHaveLength(2);
    expect(readLocalBackupTarget("github")?.pendingEvents).toBe(2);
    held.release();
    await confirmed(3);
    const marks = puts()
      .slice(1)
      .map((row) => {
        const request = JSON.parse(row.body);
        return JSON.parse(Buffer.from(request.content, "base64").toString())
          .vault.body.ivB64;
      });
    expect(marks).toEqual([first, second]);
    await restoreAndCheck("held-second-revision-canary");
  } finally {
    held.release();
  }
});

it("waits for the real VFS body write before observing and exporting the edited ciphertext", async () => {
  await initialize();
  const original = fixture.contents?.toString();
  if (!original) throw new Error("Missing real initial backup");
  const before = bodyMark();
  const key = tombFileKey(vaultStore.getSnapshot().tomb, BODY_PATH);
  const originalWrite = vfsSeams.writeRaw;
  let arrived = () => {};
  let release = () => {};
  let intercepted = false;
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = vi
    .spyOn(vfsSeams, "writeRaw")
    .mockImplementation(async (path, bytes) => {
      if (path === key && !intercepted) {
        intercepted = true;
        arrived();
        await gate;
      }
      await originalWrite(path, bytes);
    });
  const saving = editSecret("durably-written-revision-canary");
  try {
    await arrival;
    expect(bodyMark()).toBe(before);
    await readUnchangedProvider(original);
    expect(puts()).toHaveLength(1);
    release();
    const mark = await saving;
    await confirmed(2);
    expect(mark).not.toBe(before);
    expect(
      JSON.parse(fixture.contents?.toString() ?? "null").vault.body.ivB64,
    ).toBe(mark);
    write.mockRestore();
    await restoreAndCheck("durably-written-revision-canary");
  } finally {
    release();
    await saving;
    write.mockRestore();
  }
});
