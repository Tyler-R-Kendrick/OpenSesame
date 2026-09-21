/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalBackupTarget } from "./backup-target-local.js";
import {
  backupSeams,
  branchForEnvironment,
  filterGithubBackupConnections,
  filterPrivateGithubRepos,
  getBackupStatus,
  installationIdFromLocation,
  ownerRepoFromRemote,
  putBackupTarget,
  resyncBackup,
  setBackupTargetEnabled,
} from "./backup.js";
import {
  publishBackupSyncEvent,
  subscribeBackupSyncEvents,
} from "./vault-backup-observer.js";
import { vaultBackupSyncSeams } from "./vault-backup-sync.js";

const originalSync = { ...vaultBackupSyncSeams };
const originalBackup = { ...backupSeams };

beforeEach(() => {
  clearLocalBackupTarget();
  Object.assign(vaultBackupSyncSeams, originalSync);
  Object.assign(backupSeams, originalBackup);
});

afterEach(() => {
  Object.assign(vaultBackupSyncSeams, originalSync);
  Object.assign(backupSeams, originalBackup);
});

describe("browser-local backup target", () => {
  it("stores a target on this device and reports it", async () => {
    const target = await putBackupTarget({
      connectionId: "conn_1",
      installationId: "777",
      owner: "acme",
      repo: "opensesame-passwords",
      branch: "main",
      enabled: true,
    });
    expect(target.repo).toBe("opensesame-passwords");
    expect(target.enabled).toBe(true);
    const status = await getBackupStatus();
    expect(status.target?.owner).toBe("acme");
    expect(status.target?.connectionId).toBe("conn_1");
  });

  it("publishes configured when a repo is bound while enabled", async () => {
    const events: string[] = [];
    const stop = subscribeBackupSyncEvents((event) => {
      events.push(event.reason);
    });
    Object.assign(vaultBackupSyncSeams, {
      sealedEnvelopeJson: () => '{"format":"opensesame-offline-backup"}',
      putContents: vi.fn(async () => ({ commitSha: "abc" })),
    });
    await putBackupTarget({
      installationId: "9",
      owner: "acme",
      repo: "vault",
      enabled: true,
    });
    expect(events).toContain("configured");
    stop();
  });

  it("publishes enabled when backup is turned back on", async () => {
    Object.assign(vaultBackupSyncSeams, {
      sealedEnvelopeJson: () => "{}",
      putContents: vi.fn(async () => ({ commitSha: "def" })),
    });
    await putBackupTarget({
      installationId: "9",
      owner: "acme",
      repo: "vault",
      enabled: false,
    });
    const events: string[] = [];
    const stop = subscribeBackupSyncEvents((event) => {
      events.push(event.reason);
    });
    await setBackupTargetEnabled(true);
    expect(events).toContain("enabled");
    stop();
  });

  it("manual resync invokes the backup seam", async () => {
    const sync = vi.fn(async () => undefined);
    Object.assign(backupSeams, { resyncBackup: sync });
    await resyncBackup();
    expect(sync).toHaveBeenCalled();
  });

  it("maps remotes and environments to owner/repo/branch", () => {
    expect(
      ownerRepoFromRemote("https://github.com/acme/opensesame-passwords.git"),
    ).toEqual({
      owner: "acme",
      repo: "opensesame-passwords",
    });
    expect(ownerRepoFromRemote("acme/opensesame-passwords")).toEqual({
      owner: "acme",
      repo: "opensesame-passwords",
    });
    expect(ownerRepoFromRemote("https://github.com/acme")).toBeNull();
    expect(branchForEnvironment("production")).toBe("env/production");
    expect(branchForEnvironment("development")).toBe("env/development");
  });

  it("lists only active GitHub connections for recoverability", () => {
    expect(
      filterGithubBackupConnections([
        { providerId: "github", status: "active" },
        { providerId: "github", status: "needs_reauth" },
        { providerId: "gitlab", status: "active" },
      ]),
    ).toEqual([{ providerId: "github", status: "active" }]);
  });

  it("keeps only private repos for backup binding", () => {
    expect(
      filterPrivateGithubRepos([
        { private: true, name: "a" },
        { private: false, name: "b" },
      ]),
    ).toEqual([{ private: true, name: "a" }]);
  });

  it("reads installation id from the return location", () => {
    expect(installationIdFromLocation("?installation_id=42")).toBe("42");
    expect(installationIdFromLocation("installationId=7")).toBe("7");
    expect(installationIdFromLocation("")).toBeNull();
  });
});

describe("backup sync event bus", () => {
  it("notifies subscribers for webhook nudges", () => {
    const seen: string[] = [];
    const stop = subscribeBackupSyncEvents((event) => {
      seen.push(event.reason);
    });
    Object.assign(vaultBackupSyncSeams, {
      sealedEnvelopeJson: () => "{}",
      putContents: vi.fn(async () => ({ commitSha: "w" })),
    });
    // No target → runSync no-ops after publish
    publishBackupSyncEvent("webhook");
    expect(seen).toEqual(["webhook"]);
    stop();
  });
});
