/**
 * The at-rest seal when things go wrong (ADR 0149): a key that never loads,
 * a flush the quota refuses, a key record that is gone while its seals
 * remain, a reset in another tab, and a file sealed under another key. In
 * every case nothing is written in the clear and nothing is overwritten.
 */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createMemoryStorage } from "../../memory-storage.js";
import { type WebStorage, localStore } from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import {
  kvDeleteDurable,
  kvForgetAll,
  kvHydrate,
  kvSetDurable,
} from "../kv.js";
import {
  haltStorageWrites,
  resumeStorageWritesForTest,
} from "../storage-halt.js";
import { atRestBinding, sealAtRest } from "./cipher.js";
import { fakeIndexedDb } from "./fake-idb.test-support.js";
import { loadIndexedDbAtRestKey } from "./idb-key-store.js";
import {
  AT_REST_LOAD_TIMEOUT_MS,
  atRestReady,
  forgetAtRestKeyForTest,
  onAtRestReady,
} from "./key.js";
import { deviceHoldsSeals } from "./sealed-evidence.js";
import { forgetHeldWebStorageForTest } from "./web-storage.js";

const KEY = new Uint8Array(32).fill(3);

afterEach(() => {
  vi.useRealTimers();
  resumeStorageWritesForTest();
  forgetAtRestKeyForTest();
  forgetHeldWebStorageForTest();
  kvForgetAll();
  configureHost(createTestHost());
});

describe("the key's load", () => {
  it("goes ephemeral when the browser never answers, rather than hang boot", async () => {
    vi.useFakeTimers();
    forgetAtRestKeyForTest();
    configureHost(
      createTestHost({
        atRestKeys: { load: () => new Promise<Uint8Array>(() => {}) },
      }),
    );
    const ready = atRestReady();
    await vi.advanceTimersByTimeAsync(AT_REST_LOAD_TIMEOUT_MS + 1);
    expect((await ready).durable).toBe(false);
  });

  it("settles every listener even when one throws", async () => {
    let resolve: (key: Uint8Array) => void = () => {};
    forgetAtRestKeyForTest();
    configureHost(
      createTestHost({
        atRestKeys: {
          load: () =>
            new Promise<Uint8Array>((ok) => {
              resolve = ok;
            }),
        },
      }),
    );
    const heard: string[] = [];
    const ready = atRestReady();
    onAtRestReady(() => {
      throw new Error("quota");
    });
    onAtRestReady(() => heard.push("second"));
    resolve(KEY);
    expect((await ready).durable).toBe(true);
    expect(heard).toEqual(["second"]);
  });

  it("keeps a held write in memory when the quota refuses its flush", async () => {
    let resolve: (key: Uint8Array) => void = () => {};
    forgetAtRestKeyForTest();
    const refusing: WebStorage = {
      ...createMemoryStorage(),
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {},
    };
    configureHost(
      createTestHost({
        storage: { local: refusing },
        atRestKeys: {
          load: () =>
            new Promise<Uint8Array>((ok) => {
              resolve = ok;
            }),
        },
      }),
    );
    localStore().setItem("opensesame.settings", "held");
    resolve(KEY);
    await atRestReady();
    expect(localStore().getItem("opensesame.settings")).toBe("held");
  });
});

describe("a key record that is gone while its seals remain", () => {
  it("is not replaced by a new key", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    await expect(loadIndexedDbAtRestKey(async () => false)).rejects.toThrow(
      /key is gone/,
    );
  });

  it("uses another tab's key minted a moment ago", async () => {
    const { factory } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    const theirs = await loadIndexedDbAtRestKey();
    expect(await loadIndexedDbAtRestKey(async () => false)).toEqual(theirs);
  });

  it("is not recreated by a tab whose browser is being reset", async () => {
    const { factory, databases } = fakeIndexedDb();
    configureHost(createTestHost({ indexedDB: factory }));
    haltStorageWrites();
    await expect(loadIndexedDbAtRestKey()).rejects.toThrow();
    expect(databases.size).toBe(0);
  });
});

describe("a file sealed under another key", () => {
  it("reads as absent and is never written over", async () => {
    const files = new Map<string, string>();
    const name = "opensesame-pages-tomb_personal_header.json";
    files.set(
      name,
      sealAtRest(
        new Uint8Array(32).fill(9),
        atRestBinding("origin-file", name),
        '{"old":"vault"}',
      ),
    );
    const root = {
      getFileHandle: async (file: string, opts?: { create?: boolean }) => {
        if (!files.has(file) && !opts?.create) {
          throw new DOMException("gone", "NotFoundError");
        }
        return {
          getFile: async () => new Blob([files.get(file) ?? ""]),
          createWritable: async () => ({
            write: async (text: string) => {
              files.set(file, text);
            },
            close: async () => {},
          }),
        };
      },
    };
    const handle: FileSystemDirectoryHandle = overlapCast(root);
    configureHost(
      createTestHost({ originFiles: () => Promise.resolve(handle) }),
    );
    await kvHydrate(["tomb/personal/header"]);
    const before = files.get(name);
    await expect(
      kvSetDurable("tomb/personal/header", '{"new":"vault"}'),
    ).rejects.toThrow(/another key/);
    expect(files.get(name)).toBe(before);
  });
});

describe("what counts as a key that existed", () => {
  it.each(["osr1.AA", "osr9.AA"])(
    "preserves missing-root protection for %s origin files",
    async (text) => {
      const root = {
        entries: async function* () {
          yield ["opensesame-pages-legacy.json", { kind: "file" }];
        },
        getFileHandle: async () => ({ getFile: async () => new Blob([text]) }),
      };
      const handle: FileSystemDirectoryHandle = overlapCast(root);
      configureHost(
        createTestHost({ originFiles: () => Promise.resolve(handle) }),
      );
      expect(await deviceHoldsSeals()).toBe(true);
    },
  );
  it("is not one tab's session storage, nor an origin store that will not list", async () => {
    const session = createMemoryStorage();
    session.setItem(
      "opensesame.claim",
      sealAtRest(KEY, atRestBinding("web-storage.session", "x"), "x"),
    );
    configureHost(
      createTestHost({
        storage: { local: createMemoryStorage(), session },
        originFiles: () => Promise.reject(new Error("private mode")),
      }),
    );
    expect(await deviceHoldsSeals()).toBe(false);
  });
});

describe("a deleted unreadable record", () => {
  it("can be written again", async () => {
    const files = new Map<string, string>([
      [
        "opensesame-pages-gone.json",
        sealAtRest(
          new Uint8Array(32).fill(9),
          atRestBinding("origin-file", "opensesame-pages-gone.json"),
          "old",
        ),
      ],
    ]);
    const root = {
      getFileHandle: async (file: string, opts?: { create?: boolean }) => {
        if (!files.has(file) && !opts?.create) {
          throw new DOMException("gone", "NotFoundError");
        }
        return {
          getFile: async () => new Blob([files.get(file) ?? ""]),
          createWritable: async () => ({
            write: async (text: string) => {
              files.set(file, text);
            },
            close: async () => {},
          }),
        };
      },
      removeEntry: async (file: string) => {
        files.delete(file);
      },
    };
    const handle: FileSystemDirectoryHandle = overlapCast(root);
    configureHost(
      createTestHost({ originFiles: () => Promise.resolve(handle) }),
    );
    await kvHydrate(["gone"]);
    await kvDeleteDurable("gone");
    await kvSetDurable("gone", "new");
    expect(files.has("opensesame-pages-gone.json")).toBe(true);
  });
});
