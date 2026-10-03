/** @vitest-environment jsdom */
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
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

type OpenRequest = {
  onsuccess?: () => void;
  onerror?: () => void;
  onupgradeneeded?: () => void;
  result?: BoundaryValue;
};
type ListRequest = {
  onsuccess?: () => void;
  onerror?: () => void;
  result: BoundaryValue[];
};
type PutRequest = {
  onsuccess?: () => void;
  onerror?: () => void;
  error: Error;
};

describe("history backup IndexedDB failures", () => {
  it("propagates a failed IndexedDB write instead of falling back to memory", async () => {
    const failing = {
      open: () => {
        const req: OpenRequest = {};
        req.result = {
          transaction: () => ({
            objectStore: () => ({
              getAll: () => {
                const listed: ListRequest = { result: [] };
                queueMicrotask(() => listed.onsuccess?.());
                return listed;
              },
              put: () => {
                const put: PutRequest = { error: new Error("quota exceeded") };
                queueMicrotask(() => put.onerror?.());
                return put;
              },
            }),
          }),
          close: () => {},
        };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    };
    const failingIdb: IDBFactory = overlapCast(failing);
    configureHost(createTestHost({ indexedDB: failingIdb }));
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
      configureHost(createTestHost());
    }
  });
});
