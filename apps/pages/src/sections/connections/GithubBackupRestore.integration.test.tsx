/** @vitest-environment jsdom */
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
} from "@opensesame/app-core/lib/backup-target-local.js";
import { putBackupTarget } from "@opensesame/app-core/lib/backup.js";
import { ensureDeviceIdentityKey } from "@opensesame/app-core/lib/device-identity-key.js";
import { useGithubBackupProviderFixture } from "@opensesame/app-core/lib/github-app-backup-provider.test-support.js";
import { credentials } from "@opensesame/app-core/lib/github-app-direct.test-support.js";
import {
  sealPendingGithubAppSecret,
  stashPendingGithubAppSecret,
} from "@opensesame/app-core/lib/github-app-secret.js";
import {
  createProject,
  setActiveProject,
} from "@opensesame/app-core/lib/projects.js";
import * as github from "@opensesame/app-core/lib/vault-backup-github.js";
import { stopVaultBackupObserver } from "@opensesame/app-core/lib/vault-backup-observer.js";
import { syncVaultBackup } from "@opensesame/app-core/lib/vault-backup-sync.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import { createItem } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BackupSyncControls } from "./BackupSyncControls.js";

afterEach(() => {
  cleanup();
  stopVaultBackupObserver();
});
const fixture = useGithubBackupProviderFixture();
const reference = "opensesame-vault.backup.json";
async function destinationVault() {
  stopVaultBackupObserver();
  await syncVaultBackup("github");
  const ciphertext = fixture.contents?.toString();
  const sourceCommit = fixture.head;
  clearLocalBackupTarget("github");
  await vaultStore.flushPendingWrites();
  const project = await createProject(
    `Mounted GitHub restore ${crypto.randomUUID()}`,
  );
  vaultStore.lock();
  await setActiveProject(project.id);
  vaultStore.loadActiveProjectScope();
  await vaultStore.createWithPin("68391527");
  const kept = createItem("note", "Destination-only mounted note");
  await vaultStore.saveItem(kept);
  const identity = await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb);
  // Operator-supplied App key is independently sealed in this destination, never borrowed from a locked source.
  stashPendingGithubAppSecret(fixture.app, credentials.privateKey);
  await sealPendingGithubAppSecret();
  await vaultStore.flushPendingWrites();
  await putBackupTarget({
    kind: "github_app",
    providerId: "github",
    installationId: "77",
    owner: "fixture-owner",
    repo: "backups",
    branch: "backup/primary",
    enabled: true,
  });
  return { kept, identity, ciphertext, sourceCommit };
}
async function readThroughMountedControls() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Read encrypted vault backup" }),
    ).toBeTruthy(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Read encrypted vault backup" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("form", { name: "Restore vault backup" }),
    ).toBeTruthy(),
  );
}
async function submitSourcePin(pin: string) {
  fireEvent.change(screen.getByLabelText("Backup password or PIN"), {
    target: { value: pin },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Restore vault backup" }));
}
async function explicitlyBackUpMergedVault() {
  // Only this deliberate write publishes the merged vault and admits autosync.
  fireEvent.click(
    screen.getByRole("button", {
      name: "Back up this vault and enable automatic backups",
    }),
  );
  await waitFor(() =>
    expect(readLocalBackupTarget("github")?.lastCommitSha).toBe(fixture.head),
  );
  expect(fixture.requests.filter((row) => row.method === "PUT")).toHaveLength(
    2,
  );
  expect(readLocalBackupTarget("github")?.lastSyncedAt).not.toBeNull();
  await screen.findByRole("button", { name: "Sync vault backup now" });
  await vaultStore.saveItem(
    createItem("note", "Automatic update after recovered manual backup"),
  );
  await vaultStore.flushPendingWrites();
  await waitFor(() =>
    expect(fixture.requests.filter((row) => row.method === "PUT")).toHaveLength(
      3,
    ),
  );
  await waitFor(() =>
    expect(readLocalBackupTarget("github")?.lastCommitSha).toBe(fixture.head),
  );
}
it("restores actual provider ciphertext through mounted shared controls into a distinct cold PIN vault", async () => {
  const { kept, identity, ciphertext, sourceCommit } = await destinationVault();
  const readsBefore = fixture.requests.filter(
    (row) => row.method === "GET" && row.path.includes("/contents/"),
  ).length;
  render(<BackupSyncControls providerId="github" />);
  await readThroughMountedControls();
  expect(
    fixture.requests.filter(
      (row) => row.method === "GET" && row.path.includes("/contents/"),
    ).length,
  ).toBeGreaterThan(readsBefore);
  const fixed = screen.getByLabelText("Backup name or ID");
  expect(fixed).toHaveProperty("value", reference);
  expect(fixed).toHaveProperty("readOnly", true);
  expect(
    screen.queryByRole("button", { name: "Back up encrypted vault" }),
  ).toBeNull();
  await submitSourcePin("94720361");
  await waitFor(() => {
    const form = screen.getByRole("form", { name: "Restore vault backup" });
    expect(form.querySelector(".status-mark--err")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Restore encrypted vault backup" })
        .getAttribute("aria-busy"),
    ).toBeNull();
  });
  expect(
    vaultStore
      .getSnapshot()
      .items.some((item) => item.id === fixture.source.id),
  ).toBe(false);
  expect(screen.getByLabelText("Backup password or PIN")).toHaveProperty(
    "value",
    "",
  );
  expect(fixture.contents?.toString()).toBe(ciphertext);
  expect(fixture.head).toBe(sourceCommit);
  expect(fixture.requests.filter((row) => row.method === "PUT")).toHaveLength(
    1,
  );
  await submitSourcePin("83619472");
  await waitFor(() =>
    expect(
      screen.getByRole("img", { name: /items restored from encrypted backup/ }),
    ).toBeTruthy(),
  );
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: kept.id }),
      expect.objectContaining({ id: fixture.source.id }),
    ]),
  );
  expect(
    (await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb)).keyId,
  ).toBe(identity.keyId);
  // Authentication and each restore perform fresh real reads; restore never uploads or caches a local snapshot as remote proof.
  const immutableReads = fixture.requests
    .filter((row) => row.method === "GET" && row.path.includes("/contents/"))
    .slice(readsBefore);
  expect(immutableReads).toHaveLength(3);
  for (const read of immutableReads)
    expect(
      new URL(read.path, "https://api.github.com").searchParams.get("ref"),
    ).toBe(sourceCommit);
  expect(fixture.contents?.toString()).toBe(ciphertext);
  expect(fixture.head).toBe(sourceCommit);
  expect(readLocalBackupTarget("github")?.lastSyncedAt).toBeNull();
  expect(fixture.requests.filter((row) => row.method === "PUT")).toHaveLength(
    1,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Close encrypted backup" }),
  );
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  act(() => vaultStore.lock());
  await expect(vaultStore.unlockWithPin("83619472")).rejects.toThrow();
  await vaultStore.unlockWithPin("68391527");
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: fixture.source.id }),
    ]),
  );
  expect(
    (await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb)).keyId,
  ).toBe(identity.keyId);
  await explicitlyBackUpMergedVault();
});
it("does not open restore controls when actual provider authentication refuses the App", async () => {
  await destinationVault();
  fixture.mode = "denied";
  render(<BackupSyncControls providerId="github" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Read encrypted vault backup" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("img", {
        name: "The encrypted GitHub backup could not be read.",
      }),
    ).toBeTruthy(),
  );
  expect(
    screen.queryByRole("form", { name: "Restore vault backup" }),
  ).toBeNull();
  expect(fixture.requests.filter((row) => row.method === "PUT")).toHaveLength(
    1,
  );
});
it("unmount closes the original authenticated provider owner and refuses further reads", async () => {
  await destinationVault();
  const opening = vi.spyOn(github, "openSavedGithubBackup");
  const view = render(<BackupSyncControls providerId="github" />);
  await readThroughMountedControls();
  const captured = opening.mock.results[0]?.value;
  if (!captured)
    throw new Error("Actual authenticated handle was not observed");
  const handle = await captured;
  const before = fixture.requests.length;
  view.unmount();
  expect(handle.backend.signal?.aborted).toBe(true);
  await expect(
    handle.backend.getItem(reference, handle.session),
  ).rejects.toThrow();
  expect(fixture.requests).toHaveLength(before);
});
it("rejects another path and a forged session before any additional provider request", async () => {
  await destinationVault();
  const controller = new AbortController();
  const handle = await github.openSavedGithubBackup("github", {
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  });
  try {
    const before = fixture.requests.length;
    await expect(
      handle.backend.getItem("different.backup.json", handle.session),
    ).rejects.toThrow();
    await expect(
      handle.backend.getItem(reference, { ...handle.session }),
    ).rejects.toThrow();
    expect(fixture.requests).toHaveLength(before);
    controller.abort();
    expect(handle.session.signal?.aborted).toBe(true);
    await expect(
      handle.backend.getItem(reference, handle.session),
    ).rejects.toThrow();
    expect(fixture.requests).toHaveLength(before);
  } finally {
    await handle.backend.disconnect(handle.session);
  }
});
