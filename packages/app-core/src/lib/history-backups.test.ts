/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import {
  IDBFactory as MemoryIDBFactory,
  IDBObjectStore as MemoryIDBObjectStore,
} from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  putHistoryAccount,
  resetHistoryBackupMemory,
} from "./history-backup-idb.js";
import {
  HISTORY_BACKUP_GROUPS,
  isHistorySelected,
  loadHistorySelections,
  toggleHistoryProvider,
} from "./history-backups.js";
import { loadSettings, saveSettings } from "./settings.js";
import { HISTORY_BACKUP_DATABASE } from "./storage-ownership.js";

describe("history backups", () => {
  beforeEach(() => {
    resetHistoryBackupMemory();
    const current = loadSettings();
    saveSettings({
      ...current,
      capabilityConnectors: {
        ...current.capabilityConnectors,
        history: { providerId: "github" },
      },
    });
  });

  it("offers git remotes only", () => {
    expect(HISTORY_BACKUP_GROUPS.map((group) => group.id)).toEqual(["git"]);
    expect(HISTORY_BACKUP_GROUPS[0]?.providerIds).toEqual([
      "github",
      "password-store",
      "gitlab",
      "bitbucket",
      "codeberg",
      "origin",
      "git",
    ]);
  });

  it("refuses a provider that is not a git remote", async () => {
    await expect(toggleHistoryProvider("supabase")).rejects.toThrow(
      /unknown history provider/,
    );
  });

  it("multi-selects git remotes", async () => {
    await toggleHistoryProvider("password-store");
    await toggleHistoryProvider("gitlab");
    const ids = loadHistorySelections().map((row) => row.providerId);
    expect(ids).toEqual(["github", "password-store", "gitlab"]);
  });

  it("lets the last history remote turn off", async () => {
    expect(isHistorySelected("github")).toBe(true);
    await toggleHistoryProvider("github");
    expect(loadHistorySelections()).toEqual([]);
    expect(isHistorySelected("github")).toBe(false);
  });
});

type PutRequest = {
  onsuccess?: () => void;
  onerror?: () => void;
  error: Error;
};

describe("history backup IndexedDB failures", () => {
  it("propagates a failed IndexedDB write instead of falling back to memory", async () => {
    // The maintained fixture dispatches real transaction-complete tasks for
    // the preceding migration reads; only this explicit write is made to fail.
    const originalPut = MemoryIDBObjectStore.prototype.put;
    const quota = vi
      .spyOn(MemoryIDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof originalPut>
      ) {
        if (
          this.transaction.db.name !== HISTORY_BACKUP_DATABASE ||
          this.name !== "accounts"
        )
          return originalPut.apply(this, args);
        const put: PutRequest = { error: new Error("quota exceeded") };
        queueMicrotask(() => put.onerror?.());
        return overlapCast<PutRequest, IDBRequest<IDBValidKey>>(put);
      });
    configureHost(createTestHost({ indexedDB: new MemoryIDBFactory() }));
    try {
      await expect(
        putHistoryAccount({
          id: "acct_1",
          providerId: "postgres",
          anonToken: "token",
          claimState: "provisional",
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toThrow("quota exceeded");
    } finally {
      quota.mockRestore();
      configureHost(createTestHost());
    }
  });
});
