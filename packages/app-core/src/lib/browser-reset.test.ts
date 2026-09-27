/**
 * Reset this browser: what the app keeps on the origin is emptied and
 * nothing else is — the origin is shared with other sites — the session is
 * signed out before any of it, other tabs are told before the first store
 * goes and again after the last, and this tab's own writes land before the
 * files are listed and are refused after. A relying party's SDK session on
 * the same origin (`opensesame:session`) is not the app's.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { maybeLocalStore } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { RESET_LOCK } from "./browser-reset-channel.js";
import {
  FOREIGN_SCOPE,
  NO_PORTS,
  SCOPE,
  broadcastHub,
  cacheStore,
  databaseFactory,
  memoryStorage,
  originRoot,
  ownsCache,
  registration,
  workerContainer,
} from "./browser-reset.fixture.js";
import {
  type BrowserResetReport,
  browserResetSeams,
  resetBrowser,
} from "./browser-reset.js";
import { kvSet, kvSetDurable } from "./kv.js";
import { sessionExitSeams } from "./session-exit.js";
import {
  browserResetting,
  resumeStorageWritesForTest,
} from "./storage-halt.js";

const original = {
  signOut: sessionExitSeams.signOut,
  ...browserResetSeams,
};

afterEach(() => {
  sessionExitSeams.signOut = original.signOut;
  browserResetSeams.flushWrites = original.flushWrites;
  browserResetSeams.networkAnswers = original.networkAnswers;
  resumeStorageWritesForTest();
  configureHost(createTestHost());
});

const OURS = { scope: SCOPE, ownsCache } as const;

/** Lands a held origin-file write when the test says so. */
type LandingGate = { land?: () => void };

function quiet(): void {
  sessionExitSeams.signOut = () => undefined;
  browserResetSeams.networkAnswers = async () => true;
}

describe("resetBrowser: only what the app owns", () => {
  it("empties the app's own stores and leaves every other site's", async () => {
    const local = memoryStorage(
      ["opensesame:federation:last-method", "google"],
      ["opensesame.keybindings.v1", "{}"],
      ["join.presented.v1", "{}"],
      ["other", "x"],
      // Another project site's settings, named like ours but not ours.
      ["opensesame-docs.theme", "dark"],
      ["msal.3.account.keys", "[]"],
    );
    const session = memoryStorage(
      ["opensesame:federation:session", "{}"],
      ["join.pending.v2", "{}"],
      // A relying party's SDK session on this origin.
      ["opensesame:session", "{}"],
      ["opensesame:pkce", "{}"],
      ["msal.3.token.keys.client", "{}"],
      ["theirs", "y"],
    );
    const root = originRoot([
      "opensesame-pages-settings.v1.json",
      "opensesame-pages-tomb_personal_vault.body.v1.json",
      "tomb",
      "their-notes.json",
    ]);
    const databases = databaseFactory([
      "opensesame-history-backups",
      "their-db",
    ]);
    const caches = cacheStore([
      "opensesame-pages:/OpenSesame/:r1:core-only",
      "opensesame-pages:/OpenSesame/:r2:staging",
      "opensesame-pages:/other-site/:r1:core-only",
      "workbox-precache-v2",
    ]);
    const ours = registration(SCOPE, { subscribed: true });
    const theirs = registration(FOREIGN_SCOPE, { subscribed: true });
    const hub = broadcastHub();
    quiet();
    configureHost(
      createTestHost({
        storage: { local, session },
        originFiles: async () => overlapCast(root),
        indexedDB: overlapCast(databases),
        cacheStorage: caches.port,
        serviceWorker: workerContainer(ours, theirs),
        broadcast: hub.open,
      }),
    );

    const report = await resetBrowser(OURS);

    expect(report.failed).toEqual([]);
    expect(report.kept).toEqual([]);
    expect([...report.cleared].sort()).toEqual([
      "caches",
      "databases",
      "origin_files",
      "push_subscription",
      "service_workers",
      "session",
      "web_storage",
    ]);
    expect([...local.map.keys()]).toEqual([
      "other",
      "opensesame-docs.theme",
      "msal.3.account.keys",
    ]);
    expect([...session.map.keys()]).toEqual([
      "opensesame:session",
      "opensesame:pkce",
      "msal.3.token.keys.client",
      "theirs",
    ]);
    expect([...root.files]).toEqual(["tomb", "their-notes.json"]);
    expect(databases.deleted).toEqual(["opensesame-history-backups"]);
    expect([...databases.live]).toEqual(["their-db"]);
    expect([...caches.live]).toEqual([
      "opensesame-pages:/other-site/:r1:core-only",
      "workbox-precache-v2",
    ]);
    expect(ours.unregister).toHaveBeenCalledTimes(1);
    expect(ours.unsubscribe).toHaveBeenCalledTimes(1);
    expect(theirs.unregister).not.toHaveBeenCalled();
    expect(theirs.unsubscribe).not.toHaveBeenCalled();
  });
});

describe("resetBrowser: other tabs and this tab's own writes", () => {
  it("holds the reset lock throughout: announces, signs out, flushes, halts, clears, announces again", async () => {
    const order: string[] = [];
    const local = memoryStorage(["opensesame.settings-source", "{}"]);
    const root = originRoot(["opensesame-pages-a.json"]);
    const hub = broadcastHub(() => order.push("announce"));
    quiet();
    // By the time anything runs, the app is no longer offered (ResetGate).
    sessionExitSeams.signOut = () =>
      order.push(
        browserResetting() ? "signOut" : "signOut (app still offered)",
      );
    browserResetSeams.flushWrites = async () => {
      order.push("flush");
    };
    root.removeEntry.mockImplementation(async (name: string) => {
      order.push(`remove:${name}`);
      root.files.delete(name);
      // Writes after the flush are refused: the Web Storage port does
      // nothing, and an origin-file write rejects before it starts.
      maybeLocalStore()?.setItem("opensesame.late", "1");
      await expect(kvSetDurable("late", "1")).rejects.toThrow(/reset/);
    });
    configureHost(
      createTestHost({
        ...NO_PORTS,
        storage: { local },
        originFiles: async () => overlapCast(root),
        broadcast: hub.open,
        locks: overlapCast({
          request: async (
            name: string,
            run: () => Promise<BrowserResetReport>,
          ) => {
            order.push(`lock:${name}`);
            try {
              return await run();
            } finally {
              order.push("unlock");
            }
          },
        }),
      }),
    );

    await resetBrowser(OURS);

    expect(order).toEqual([
      `lock:${RESET_LOCK}`,
      "announce",
      "signOut",
      "flush",
      "remove:opensesame-pages-a.json",
      "announce",
      "unlock",
    ]);
    expect(local.map.has("opensesame.late")).toBe(false);
    expect(local.map.size).toBe(0);
  });

  it("waits for a write this tab already started before listing the files", async () => {
    const events: string[] = [];
    const files = new Set<string>();
    const gate: LandingGate = {};
    const root = {
      async *keys() {
        events.push("list");
        yield* [...files];
      },
      removeEntry: vi.fn(async (name: string) => {
        files.delete(name);
      }),
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async () => undefined,
          close: () =>
            new Promise<void>((resolve) => {
              gate.land = () => {
                files.add(name);
                events.push("landed");
                resolve();
              };
            }),
        }),
      }),
    };
    quiet();
    // Signing out locks, and the lock writes the last-vault pointer: in flight.
    sessionExitSeams.signOut = () => kvSet("opensesame.last-vault.v1", "p");
    configureHost(
      createTestHost({
        ...NO_PORTS,
        originFiles: async () => overlapCast(root),
      }),
    );

    const running = resetBrowser(OURS);
    await vi.waitFor(() => expect(gate.land).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]);
    gate.land?.();
    const report = await running;

    expect(events.slice(0, 2)).toEqual(["landed", "list"]);
    expect(files.size).toBe(0);
    expect(report.cleared).toContain("origin_files");
  });

  it("a second pass removes what another tab wrote while the first ran", async () => {
    const root = originRoot(["opensesame-pages-a.json", "theirs.bin"]);
    let first = true;
    root.removeEntry.mockImplementation(async (name: string) => {
      root.files.delete(name);
      if (first) root.files.add("opensesame-pages-late.json");
      first = false;
    });
    quiet();
    configureHost(
      createTestHost({
        ...NO_PORTS,
        originFiles: async () => overlapCast(root),
      }),
    );

    const report = await resetBrowser(OURS);

    expect([...root.files]).toEqual(["theirs.bin"]);
    expect(report.cleared).toContain("origin_files");
  });

  it("another tab hears the reset and stops writing; the tab that ran it does not hear it", async () => {
    const hub = broadcastHub();
    const { onBrowserReset } = await import("./browser-reset-channel.js");
    quiet();
    configureHost(createTestHost({ ...NO_PORTS, broadcast: hub.open }));
    const heard = vi.fn(() =>
      // Halted before the handler runs: the reload never races a write.
      expect(kvSetDurable("x", "1")).rejects.toThrow(/reset/),
    );
    const stop = onBrowserReset(heard);

    hub.open().postMessage({ kind: "reset", tab: "another-tab" });
    expect(heard).toHaveBeenCalledTimes(1);
    hub.open().postMessage("reset");
    hub.open().postMessage(null);
    expect(heard).toHaveBeenCalledTimes(1);
    await heard.mock.results[0]?.value;

    resumeStorageWritesForTest();
    await resetBrowser(OURS);
    // Before the first store and after the last.
    expect(hub.posted.slice(-2)).toEqual([
      { kind: "reset", tab: expect.any(String), phase: "start" },
      { kind: "reset", tab: expect.any(String), phase: "done" },
    ]);
    expect(heard).toHaveBeenCalledTimes(1);

    stop();
    expect(hub.listeners.size).toBe(0);
  });
});
