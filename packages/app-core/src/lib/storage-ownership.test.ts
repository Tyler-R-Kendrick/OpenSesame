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
import { createTestHost } from "../test-host.js";
import { memoryStorage } from "./browser-reset.fixture.js";
import { kvFileName, kvFlush, kvSet, kvSetDurable } from "./kv.js";
import {
  haltStorageWrites,
  resumeStorageWritesForTest,
} from "./storage-halt.js";
import {
  HISTORY_BACKUP_DATABASE,
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
    ["opensesame.last-vault.v1", "local", true],
    ["opensesame-anything", "local", true],
    ["join.pending.v2", "session", true],
    ["msal.3.token.keys.client", "session", true],
    ["msal.3.token.keys.client", "local", false],
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
  it("refuses an unowned Web Storage key in a development build", () => {
    const local = memoryStorage();
    const session = memoryStorage();
    configureHost(createTestHost({ storage: { local, session } }));

    expect(() => maybeLocalStore()?.setItem("theme", "dark")).toThrow(
      /not one this app owns/,
    );
    expect(() => sessionStore().setItem("draft", "x")).toThrow(
      /not one this app owns/,
    );
    maybeLocalStore()?.setItem("opensesame.theme", "dark");
    expect([...local.map]).toEqual([["opensesame.theme", "dark"]]);
    expect(session.map.size).toBe(0);
  });

  it("writes an unowned key in a production build rather than break", () => {
    const local = memoryStorage();
    configureHost(createTestHost({ storage: { local }, env: { DEV: false } }));
    maybeLocalStore()?.setItem("theme", "dark");
    expect(local.map.get("theme")).toBe("dark");
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
