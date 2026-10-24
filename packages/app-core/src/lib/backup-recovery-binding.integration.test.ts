/** @vitest-environment jsdom */
import { createItem } from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import { buildLocalBackupTarget } from "./backup-target-build.js";
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import {
  putBackupTarget,
  resyncBackup,
  setBackupTargetEnabled,
} from "./backup.js";
import { useGithubBackupProviderFixture } from "./github-app-backup-provider.test-support.js";
import {
  startVaultBackupObserver,
  stopVaultBackupObserver,
  vaultBackupObserverSeams,
} from "./vault-backup-observer.js";
import { vaultStore } from "./vault/store.js";

const fixture = useGithubBackupProviderFixture();
afterEach(stopVaultBackupObserver);
const putCount = () =>
  fixture.requests.filter((row) => row.method === "PUT").length;
async function bindRecoveryTarget() {
  return putBackupTarget({
    kind: "github_app",
    providerId: "github",
    installationId: "77",
    owner: "fixture-owner",
    repo: "backups",
    branch: "backup/primary",
    enabled: true,
  });
}
it("keeps existing provider ciphertext unchanged through binding, immediate polling and every automatic reason", async () => {
  stopVaultBackupObserver();
  await resyncBackup("github");
  const ciphertext = fixture.contents?.toString();
  const commit = fixture.head;
  const writes = putCount();
  clearLocalBackupTarget("github");
  await bindRecoveryTarget();
  await expect
    .poll(() =>
      fixture.requests.some((row) => row.path.includes("/git/ref/heads/")),
    )
    .toBe(true);
  for (const reason of ["configured", "enabled", "vault", "webhook"] as const)
    await vaultBackupObserverSeams.runSync(reason);
  await setBackupTargetEnabled(false, "github");
  await setBackupTargetEnabled(true, "github");
  await vaultStore.saveItem(
    createItem("note", "Destination still awaiting recovery"),
  );
  await vaultStore.flushPendingWrites();
  await vaultBackupObserverSeams.runSync("vault");
  expect(putCount()).toBe(writes);
  expect(fixture.head).toBe(commit);
  expect(fixture.contents?.toString()).toBe(ciphertext);
  expect(readLocalBackupTarget("github")?.lastSyncedAt).toBeNull();
});
it("keeps recovery gated even when another bound App target is already initialized", async () => {
  stopVaultBackupObserver();
  await resyncBackup("github");
  const initialized = readLocalBackupTarget("github");
  if (!initialized) throw new Error("Actual confirmed target required");
  writeLocalBackupTarget({ ...initialized, providerId: "github-secondary" });
  writeLocalBackupTarget({
    ...initialized,
    lastSyncedAt: null,
    lastCommitSha: null,
    status: "pending",
  });
  await vaultBackupObserverSeams.runSync("vault");
  expect(readLocalBackupTarget("github")?.lastSyncedAt).toBeNull();
  expect(
    readLocalBackupTarget("github-secondary")?.lastSyncedAt,
  ).not.toBeNull();
  expect(putCount()).toBe(2);
});
it("performs the deliberate initial write and then genuine automatic vault and webhook writes, retaining pause", async () => {
  stopVaultBackupObserver();
  await bindRecoveryTarget();
  await vaultBackupObserverSeams.runSync("configured");
  expect(putCount()).toBe(0);
  await resyncBackup("github");
  expect(putCount()).toBe(1);
  expect(readLocalBackupTarget("github")).toMatchObject({
    status: "ok",
    lastCommitSha: fixture.head,
  });
  expect(readLocalBackupTarget("github")?.lastSyncedAt).not.toBeNull();
  startVaultBackupObserver();
  await vaultStore.saveItem(
    createItem("note", "Automatic mutation after explicit backup"),
  );
  await vaultStore.flushPendingWrites();
  await expect
    .poll(
      () =>
        putCount() > 1 &&
        readLocalBackupTarget("github")?.lastCommitSha === fixture.head,
    )
    .toBe(true);
  expect(readLocalBackupTarget("github")?.status).toBe("ok");
  const beforeWebhook = putCount();
  await vaultBackupObserverSeams.runSync("webhook");
  expect(putCount()).toBe(beforeWebhook + 1);
  await setBackupTargetEnabled(false, "github");
  const paused = putCount();
  await vaultStore.saveItem(createItem("note", "Paused mutation"));
  await vaultStore.flushPendingWrites();
  await vaultBackupObserverSeams.runSync("vault");
  expect(putCount()).toBe(paused);
});
it("rechecks a queued target's recovery readiness before dispatching after another provider write", async () => {
  stopVaultBackupObserver();
  await resyncBackup("github");
  const original = readLocalBackupTarget("github");
  if (!original) throw new Error("Actual confirmed target required");
  writeLocalBackupTarget({ ...original, providerId: "github-secondary" });
  writeLocalBackupTarget(original);
  const held = fixture.holdNextWrite();
  const pending = vaultBackupObserverSeams.runSync("vault");
  try {
    await held.arrived;
    writeLocalBackupTarget(
      buildLocalBackupTarget(
        { branch: "recovery-only" },
        original,
        "github",
        "github_app",
      ),
    );
  } finally {
    held.release();
  }
  await pending;
  expect(putCount()).toBe(2);
  expect(readLocalBackupTarget("github")).toMatchObject({
    branch: "recovery-only",
    lastSyncedAt: null,
  });
});
it("does not admit automatic writes after a real refused initial manual attempt", async () => {
  stopVaultBackupObserver();
  await bindRecoveryTarget();
  fixture.mode = "denied";
  await expect(resyncBackup("github")).rejects.toThrow();
  fixture.mode = "normal";
  for (const reason of ["configured", "enabled", "vault", "webhook"] as const)
    await vaultBackupObserverSeams.runSync(reason);
  expect(putCount()).toBe(0);
  expect(readLocalBackupTarget("github")?.lastSyncedAt).toBeNull();
});
it("resets only an App binding's prior confirmation when its repository authority changes", async () => {
  stopVaultBackupObserver();
  await resyncBackup("github");
  const prior = readLocalBackupTarget("github");
  if (!prior) throw new Error("Actual confirmed target required");
  for (const change of [
    { owner: "another-owner" },
    { repo: "recovery-repository" },
    { branch: "recovery" },
    { installationId: "88" },
    { connectionId: "another-connection" },
    { integrationId: "another-app" },
  ]) {
    const next = buildLocalBackupTarget(change, prior, "github", "github_app");
    expect(next).toMatchObject({
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      pendingEvents: 0,
    });
    expect(next.enabled).toBe(prior.enabled);
  }
  expect(buildLocalBackupTarget({}, prior, "github", "github_app")).toEqual(
    prior,
  );
  const forge = {
    ...prior,
    kind: "git_remote",
    providerId: "gitlab",
    connectionId: "forge-owner",
  };
  expect(
    buildLocalBackupTarget({ repo: "other" }, forge, "gitlab", "git_remote")
      .lastSyncedAt,
  ).toBe(prior.lastSyncedAt);
});
