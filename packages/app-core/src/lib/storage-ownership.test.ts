/**
 * The one ownership rule, and the places that make every store go through
 * it: the Web Storage ports refuse an unowned key in a development build,
 * IndexedDB opens only a listed name, and every origin file `kv.ts` writes
 * carries the owned prefix. Once the browser is being reset, writes stop.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { maybeLocalStore, openOwnedDatabase, sessionStore } from "../ports.js";
import {
  assertOwnedStorageWrites,
  takeStorageWrites,
} from "../test-host-storage-writes.js";
import { createTestHost } from "../test-host.js";
import { memoryStorage } from "./browser-reset.fixture.js";
import {
  appendHistoryEntry,
  listHistoryAccounts,
  putHistoryAccount,
} from "./history-backup-idb.js";
import { kvFileName, kvFlush, kvSet, kvSetDurable } from "./kv.js";
import {
  haltStorageWrites,
  resumeStorageWritesForTest,
} from "./storage-halt.js";
import {
  AT_REST_DATABASE,
  FILE_PARTS_DIRECTORY,
  HISTORY_BACKUP_DATABASE,
  PASSWORD_HISTORY_DATABASE,
  ownsDatabase,
  ownsOriginFile,
  ownsServiceWorkerScope,
  ownsWebStorageKey,
} from "./storage-ownership.js";

afterEach(() => {
  resumeStorageWritesForTest();
  configureHost(createTestHost());
});

describe("ownership", () => {
  it.each([
    ["opensesame:federation:session", "local", true],
    ["opensesame:ambient-auth:tx", "local", true],
    ["opensesame:org-profile", "session", true],
    ["opensesame.last-vault.v1", "local", true],
    ["opensesame.wallet.budget.v1.personal", "local", true],
    ["join.pending.v2", "session", true],
    // A relying party's SDK on the same origin: its session, not ours.
    ["opensesame:session", "session", false],
    ["opensesame:pkce", "session", false],
    ["opensesame:returnTo", "session", false],
    ["opensesame:static-auth:rp:https://a.test/cb", "session", false],
    // Another project site's keys.
    ["opensesame-docs.theme", "local", false],
    ["msal.3.token.keys.client", "session", false],
    ["other", "local", false],
    ["theme", "session", false],
    ["joined", "local", false],
  ] as const)("%s in %s storage → %s", (key, area, owned) => {
    expect(ownsWebStorageKey(key, area)).toBe(owned);
  });

  it("owns origin files, databases and a worker by their exact names", () => {
    expect(ownsOriginFile(kvFileName("tomb/personal/vault.body.v1"))).toBe(
      true,
    );
    expect(ownsOriginFile("tomb")).toBe(false);
    expect(ownsDatabase(HISTORY_BACKUP_DATABASE)).toBe(true);
    expect(ownsDatabase(AT_REST_DATABASE)).toBe(true);
    expect(ownsDatabase(PASSWORD_HISTORY_DATABASE)).toBe(true);
    expect(ownsOriginFile(FILE_PARTS_DIRECTORY)).toBe(true);
    expect(ownsDatabase("opensesame-history-backups-2")).toBe(false);
    expect(
      ownsServiceWorkerScope("https://a.test/x/", "https://a.test/x/"),
    ).toBe(true);
    expect(ownsServiceWorkerScope("https://a.test/", "https://a.test/x/")).toBe(
      false,
    );
  });
});

describe("the ports hold every write to the rule", () => {
  it("records every write, so a test that writes an unowned key fails", () => {
    const local = memoryStorage();
    const session = memoryStorage();
    configureHost(createTestHost({ storage: { local, session } }));

    maybeLocalStore()?.setItem("theme", "dark");
    sessionStore().setItem("opensesame:session", "{}");
    maybeLocalStore()?.setItem("opensesame.theme", "dark");

    // The write goes through (a shell has no recorder), sealed; the test fails.
    expect(maybeLocalStore()?.getItem("theme")).toBe("dark");
    expect(local.map.get("theme")).not.toBe("dark");
    expect(() => assertOwnedStorageWrites()).toThrow(
      /local:theme, session:opensesame:session/,
    );
    // Taken by the check, so this test itself passes.
    expect(takeStorageWrites()).toEqual([]);
  });

  it("catches a key whose write the caller's try/catch swallowed", () => {
    configureHost(createTestHost({ storage: { local: memoryStorage() } }));
    try {
      maybeLocalStore()?.setItem("draft", "x");
      throw new Error("the caller's own failure");
    } catch {
      // swallowed, as `last-sign-in.ts` and `settings-source.ts` do
    }
    expect(takeStorageWrites()).toEqual([{ area: "local", key: "draft" }]);
  });

  it("opens only a database the rule lists", () => {
    const open = vi.fn((): IDBOpenDBRequest => overlapCast({}));
    configureHost(createTestHost({ indexedDB: overlapCast({ open }) }));

    expect(() => openOwnedDatabase("their-db", 1)).toThrow(
      /not one this app owns/,
    );
    openOwnedDatabase(HISTORY_BACKUP_DATABASE, 1);
    expect(open).toHaveBeenCalledWith(HISTORY_BACKUP_DATABASE, 1);
  });

  it("stops every write once the browser is being reset", async () => {
    const local = memoryStorage();
    const created: string[] = [];
    configureHost(
      createTestHost({
        storage: { local },
        originFiles: async () =>
          overlapCast({
            getFileHandle: async (name: string) => {
              created.push(name);
              return {
                createWritable: async () => ({
                  write: async () => undefined,
                  close: async () => undefined,
                }),
              };
            },
          }),
      }),
    );
    haltStorageWrites();

    maybeLocalStore()?.setItem("opensesame.theme", "dark");
    kvSet("settings.v1", "{}");
    await expect(kvSetDurable("settings.v1", "{}")).rejects.toThrow(/reset/);
    await kvFlush();

    expect(local.map.size).toBe(0);
    expect(created).toEqual([]);
  });
});

describe("a halted tab and IndexedDB", () => {
  it("never opens the history database, which opening would recreate", async () => {
    const open = vi.fn((): IDBOpenDBRequest => overlapCast({}));
    configureHost(createTestHost({ indexedDB: overlapCast({ open }) }));
    haltStorageWrites();

    await putHistoryAccount({
      id: "hacc_1",
      providerId: "neon",
      anonToken: "t",
      claimState: "provisional",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    await appendHistoryEntry("hacc_1", new Uint8Array([1]));
    await listHistoryAccounts();

    expect(open).not.toHaveBeenCalled();
  });
});

describe("kvFlush", () => {
  it("resolves only once every write already started has landed", async () => {
    const release: (() => void)[] = [];
    configureHost(
      createTestHost({
        originFiles: async () =>
          overlapCast({
            getFileHandle: async () => ({
              createWritable: async () => ({
                write: async () => undefined,
                close: () =>
                  new Promise<void>((resolve) => release.push(resolve)),
              }),
            }),
          }),
      }),
    );
    kvSet("a", "1");
    kvSet("b", "2");
    let flushed = false;
    const flushing = kvFlush().then(() => {
      flushed = true;
    });

    await vi.waitFor(() => expect(release).toHaveLength(2));
    release[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(flushed).toBe(false);
    release[1]?.();
    await flushing;
    expect(flushed).toBe(true);
  });
});
