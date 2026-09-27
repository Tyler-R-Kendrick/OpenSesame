/**
 * Reset this browser: every store the app keeps on the origin is emptied,
 * the session is signed out before any of it, a store that refuses does not
 * stop the others, and other tabs hear about it — this one does not.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import type { BroadcastLike, Ports, WebStorage } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { onBrowserReset } from "./browser-reset-channel.js";
import { resetBrowser } from "./browser-reset.js";
import { sessionExitSeams } from "./session-exit.js";

const originalSignOut = sessionExitSeams.signOut;

afterEach(() => {
  sessionExitSeams.signOut = originalSignOut;
  configureHost(createTestHost());
});

/** What a fake tab posts on the reset channel. */
type Posted = Readonly<{ kind: string; tab: string }> | string | null;

/** No port at all: the reset has nothing to clear there. */
const NO_PORTS: Partial<Ports> = {
  storage: {},
  originFiles: undefined,
  indexedDB: undefined,
  cacheStorage: undefined,
  serviceWorker: undefined,
  broadcast: undefined,
};

function memoryStorage(
  ...entries: (readonly [string, string])[]
): WebStorage & {
  map: Map<string, string>;
} {
  const map = new Map(entries);
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function originRoot(names: string[]) {
  const files = new Set(names);
  return {
    files,
    async *keys() {
      yield* [...files];
    },
    removeEntry: vi.fn(async (name: string) => {
      files.delete(name);
    }),
  };
}

type DeleteRequest = { onsuccess?: () => void; error: null };

function databaseFactory(names: string[]) {
  const live = new Set(names);
  return {
    live,
    databases: async () => [...live].map((name) => ({ name, version: 1 })),
    deleteDatabase(name: string): DeleteRequest {
      const request: DeleteRequest = { error: null };
      queueMicrotask(() => {
        live.delete(name);
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function broadcastHub() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: Posted[] = [];
  const open = (): BroadcastLike =>
    overlapCast({
      postMessage(data: Posted) {
        posted.push(data);
        const event: MessageEvent = overlapCast({ data });
        for (const listener of listeners) listener(event);
      },
      close() {},
      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.add(listener);
      },
      removeEventListener(
        _type: string,
        listener: (event: MessageEvent) => void,
      ) {
        listeners.delete(listener);
      },
      onmessage: null,
    });
  return { open, posted, listeners };
}

describe("resetBrowser", () => {
  it("signs out, then empties every store the app keeps on this origin", async () => {
    const order: string[] = [];
    const local = memoryStorage(["opensesame:settings", "{}"], ["other", "x"]);
    const session = memoryStorage(["opensesame:federation", "{}"]);
    const root = originRoot(["opensesame-pages-a.json", "tomb"]);
    const databases = databaseFactory(["opensesame-history-backups"]);
    const cacheNames = new Set(["shell-v1", "shell-v2"]);
    const unregister = vi.fn(async () => true);
    const hub = broadcastHub();
    sessionExitSeams.signOut = () => {
      order.push("signOut");
      // Sign-out records its outcome; the reset must not leave it behind.
      local.setItem("opensesame:auth-outcome", "signed_out");
    };
    root.removeEntry.mockImplementation(async (name: string) => {
      order.push(`file:${name}`);
      root.files.delete(name);
    });
    configureHost(
      createTestHost({
        storage: { local, session },
        originFiles: async () => overlapCast(root),
        indexedDB: overlapCast(databases),
        cacheStorage: overlapCast({
          keys: async () => [...cacheNames],
          delete: async (name: string) => cacheNames.delete(name),
        }),
        serviceWorker: overlapCast({
          getRegistrations: async () => [{ unregister }, { unregister }],
        }),
        broadcast: hub.open,
      }),
    );

    const report = await resetBrowser();

    expect(report.failed).toEqual([]);
    expect(report.cleared).toEqual([
      "session",
      "origin_files",
      "databases",
      "web_storage",
      "caches",
      "service_workers",
    ]);
    expect(order[0]).toBe("signOut");
    expect(root.files.size).toBe(0);
    expect(root.removeEntry).toHaveBeenCalledWith("tomb", { recursive: true });
    expect(databases.live.size).toBe(0);
    expect(local.map.size).toBe(0);
    expect(session.map.size).toBe(0);
    expect(cacheNames.size).toBe(0);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(hub.posted).toEqual([{ kind: "reset", tab: expect.any(String) }]);
  });

  it("keeps going past a store that refuses, and names it", async () => {
    const local = memoryStorage(["key", "value"]);
    sessionExitSeams.signOut = () => undefined;
    configureHost(
      createTestHost({
        ...NO_PORTS,
        storage: { local },
        originFiles: async () => {
          throw new DOMException("denied", "SecurityError");
        },
      }),
    );

    const report = await resetBrowser();

    expect(report.failed).toEqual(["origin_files"]);
    expect(report.cleared).toContain("web_storage");
    expect(local.map.size).toBe(0);
  });

  it("another tab hears the reset; the tab that ran it does not", async () => {
    const hub = broadcastHub();
    sessionExitSeams.signOut = () => undefined;
    configureHost(createTestHost({ ...NO_PORTS, broadcast: hub.open }));
    const heard = vi.fn();
    const stop = onBrowserReset(heard);

    hub.open().postMessage({ kind: "reset", tab: "another-tab" });
    expect(heard).toHaveBeenCalledTimes(1);
    hub.open().postMessage("reset");
    hub.open().postMessage(null);
    expect(heard).toHaveBeenCalledTimes(1);

    // This tab's own announcement is not a reason to reload over its own
    // navigation.
    await resetBrowser();
    expect(hub.posted.at(-1)).toMatchObject({ kind: "reset" });
    expect(heard).toHaveBeenCalledTimes(1);

    stop();
    expect(hub.listeners.size).toBe(0);
  });
});
