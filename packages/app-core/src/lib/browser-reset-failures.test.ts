/**
 * Reset this browser when something will not go: every refusal is named in
 * the report, the other areas are still attempted, and nothing is counted
 * as removed that is still there. And the app shell: kept unless the
 * network actually answers, with its push subscription ended either way.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { clearDatabases, networkAnswers } from "./browser-reset-areas.js";
import {
  NO_PORTS,
  SCOPE,
  cacheStore,
  databaseFactory,
  memoryStorage,
  originRoot,
  ownsCache,
  registration,
  workerContainer,
} from "./browser-reset.fixture.js";
import { browserResetSeams, resetBrowser } from "./browser-reset.js";
import { sessionExitSeams } from "./session-exit.js";
import { resumeStorageWritesForTest } from "./storage-halt.js";

const original = { signOut: sessionExitSeams.signOut, ...browserResetSeams };

afterEach(() => {
  sessionExitSeams.signOut = original.signOut;
  browserResetSeams.networkAnswers = original.networkAnswers;
  resumeStorageWritesForTest();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});

const OURS = { scope: SCOPE, ownsCache } as const;

function host(ports: Parameters<typeof createTestHost>[0]): void {
  sessionExitSeams.signOut = () => undefined;
  configureHost(createTestHost({ ...NO_PORTS, ...ports }));
}

describe("resetBrowser: refusals", () => {
  it("names origin files that would not go, and keeps going", async () => {
    const local = memoryStorage(["opensesame.settings-source", "{}"]);
    const root = originRoot(["opensesame-pages-a.json", "opensesame-pages-b"]);
    root.removeEntry.mockImplementation(async (name: string) => {
      if (name === "opensesame-pages-b") {
        throw new DOMException("locked", "NoModificationAllowedError");
      }
      root.files.delete(name);
    });
    host({ storage: { local }, originFiles: async () => overlapCast(root) });
    browserResetSeams.networkAnswers = async () => true;

    const report = await resetBrowser(OURS);

    expect(report.failed).toEqual(["origin_files"]);
    expect(report.cleared).toContain("web_storage");
    expect(local.map.size).toBe(0);
    expect([...root.files]).toEqual(["opensesame-pages-b"]);
  });

  it("counts a file that is already gone as removed", async () => {
    const root = originRoot(["opensesame-pages-a.json"]);
    root.removeEntry.mockRejectedValue(new DOMException("", "NotFoundError"));
    host({ originFiles: async () => overlapCast(root) });
    browserResetSeams.networkAnswers = async () => true;

    const report = await resetBrowser(OURS);

    expect(report.failed).toEqual([]);
    expect(report.cleared).toContain("origin_files");
  });

  it("names a database whose deletion errors", async () => {
    const databases = databaseFactory(["opensesame-history-backups"], "error");
    host({ indexedDB: overlapCast(databases) });
    browserResetSeams.networkAnswers = async () => true;

    const report = await resetBrowser(OURS);

    expect(report.failed).toEqual(["databases"]);
    expect([...databases.live]).toEqual(["opensesame-history-backups"]);
  });
});

describe("clearDatabases", () => {
  it("deletes the app's databases by name where databases() is missing (Firefox before 126)", async () => {
    // The factory has deleteDatabase and nothing to list with.
    const databases = databaseFactory(["opensesame-history-backups", "x"]);
    expect("databases" in databases).toBe(false);
    host({ indexedDB: overlapCast(databases) });

    await clearDatabases();

    expect(databases.deleted).toEqual(["opensesame-history-backups"]);
    expect([...databases.live]).toEqual(["x"]);
  });

  it("reports a deletion that stays blocked instead of counting it done", async () => {
    const databases = databaseFactory(
      ["opensesame-history-backups"],
      "blocked",
    );
    host({ indexedDB: overlapCast(databases) });

    await expect(clearDatabases(20)).rejects.toThrow(/could not be removed/);
    expect([...databases.live]).toEqual(["opensesame-history-backups"]);
  });
});

describe("resetBrowser: the app shell", () => {
  function shell() {
    const caches = cacheStore(["opensesame-pages:/OpenSesame/:r1:core-only"]);
    return { caches, worker: registration(SCOPE, { subscribed: true }) };
  }

  it("offline, keeps the shell and still ends the push subscription", async () => {
    const { caches, worker } = shell();
    const probe = vi.fn(async () => true);
    browserResetSeams.networkAnswers = probe;
    host({
      cacheStorage: caches.port,
      serviceWorker: workerContainer(worker),
      environment: overlapCast({ online: false }),
    });

    const report = await resetBrowser(OURS);

    expect(report.kept).toEqual(["caches", "service_workers"]);
    expect(report.cleared).toContain("push_subscription");
    expect(report.failed).toEqual([]);
    expect(worker.unsubscribe).toHaveBeenCalledTimes(1);
    expect(worker.unregister).not.toHaveBeenCalled();
    expect(caches.live.size).toBe(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it("offline, reports the push subscription as kept when it will not end", async () => {
    const { caches } = shell();
    const worker = registration(SCOPE, {
      subscribed: true,
      unsubscribeRefuses: true,
    });
    host({
      cacheStorage: caches.port,
      serviceWorker: workerContainer(worker),
      environment: overlapCast({ online: false }),
    });

    const report = await resetBrowser(OURS);

    expect(report.kept).toEqual([
      "push_subscription",
      "caches",
      "service_workers",
    ]);
  });

  it("online by the flag but with no answer, keeps the shell", async () => {
    const { caches, worker } = shell();
    browserResetSeams.networkAnswers = async () => false;
    host({
      cacheStorage: caches.port,
      serviceWorker: workerContainer(worker),
      environment: overlapCast({ online: true }),
    });

    const report = await resetBrowser(OURS);

    expect(report.kept).toEqual(["caches", "service_workers"]);
    expect(worker.unregister).not.toHaveBeenCalled();
    expect(caches.live.size).toBe(1);
  });

  it("online with an answer, removes the shell", async () => {
    const { caches, worker } = shell();
    browserResetSeams.networkAnswers = async () => true;
    host({
      cacheStorage: caches.port,
      serviceWorker: workerContainer(worker),
      environment: overlapCast({ online: true }),
    });

    const report = await resetBrowser(OURS);

    expect(report.kept).toEqual([]);
    expect(worker.unregister).toHaveBeenCalledTimes(1);
    expect(caches.live.size).toBe(0);
  });
});

describe("networkAnswers", () => {
  it("asks the network for the app's own address, bypassing every cache", async () => {
    const fetched = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetched);

    await expect(networkAnswers(SCOPE)).resolves.toBe(true);
    expect(fetched).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ method: "HEAD", cache: "no-store" }),
    );
  });

  it("is false when the request fails, errs or never answers", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(networkAnswers(SCOPE)).resolves.toBe(false);

    vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
    await expect(networkAnswers(SCOPE)).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(networkAnswers(SCOPE, 20)).resolves.toBe(false);
  });
});
