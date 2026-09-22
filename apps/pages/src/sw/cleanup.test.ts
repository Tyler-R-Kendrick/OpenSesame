import { describe, expect, it } from "vitest";
import { cacheName, parseCacheName, scopePathOf } from "./cache-names.js";
import { cleanupCaches, staleCacheNames } from "./cleanup.js";
import { FakeWorkerEnv } from "./test-env.js";

const SCOPE = "/OpenSesame/";
const CURRENT = cacheName(SCOPE, "cur", "core-only");
const CURRENT_PUSH = cacheName(SCOPE, "cur", "push");
const OLD = cacheName(SCOPE, "old", "core-only");
const OLDER = cacheName(SCOPE, "older", "push");
const FOREIGN = [
  "other-app-cache",
  "workbox-precache-v2-https://example.test/",
  cacheName("/other-scope/", "cur", "core-only"),
  "opensesame-pages-v3",
];
const EVERYTHING = [CURRENT, CURRENT_PUSH, OLD, OLDER, ...FOREIGN];

/** What PWA-04 demands of any cleanup: nothing foreign, nothing current. */
function assertForeignAndCurrentSurvive(remaining: readonly string[]): void {
  for (const name of [...FOREIGN, CURRENT, CURRENT_PUSH])
    expect(remaining).toContain(name);
}

/**
 * EVID-03: the deletion the baseline worker performed — everything on the
 * origin that is not the current cache. Kept here as a test-only mutant so
 * the PWA-04 assertion is shown to fail against it.
 */
async function originWideDeletion(caches: CacheStorage): Promise<void> {
  const names = await caches.keys();
  await Promise.all(
    names.filter((name) => name !== CURRENT).map((name) => caches.delete(name)),
  );
}

describe("cache names", () => {
  it("round-trip through parse under the same scope path", () => {
    expect(parseCacheName(OLDER, SCOPE)).toEqual({
      scopePath: SCOPE,
      releaseId: "older",
      variant: "push",
    });
    expect(scopePathOf("https://h.test/OpenSesame/")).toBe(SCOPE);
  });

  it("do not parse another scope, a legacy name, or a foreign cache", () => {
    for (const name of FOREIGN) expect(parseCacheName(name, SCOPE)).toBe(null);
    expect(parseCacheName("opensesame-pages:/OpenSesame/:x", SCOPE)).toBe(null);
    expect(parseCacheName("opensesame-pages:/OpenSesame/:x:", SCOPE)).toBe(null);
  });
});

describe("cleanup (PWA-04)", () => {
  it("names only this scope's other, unretained releases as stale", () => {
    expect(
      staleCacheNames(EVERYTHING, {
        scopePath: SCOPE,
        releaseId: "cur",
        retained: new Set(["older"]),
      }),
    ).toEqual([OLD]);
  });

  it("deletes those and nothing else", async () => {
    const env = new FakeWorkerEnv();
    for (const name of EVERYTHING) await env.cacheStorage.seed(name, {});
    const deleted = await cleanupCaches({
      caches: env.cacheStorage,
      scopePath: SCOPE,
      releaseId: "cur",
      retained: new Set(["older"]),
    });
    expect(deleted).toEqual([OLD]);
    const remaining = await env.cacheStorage.keys();
    assertForeignAndCurrentSurvive(remaining);
    expect(remaining).toContain(OLDER);
    expect(remaining).not.toContain(OLD);
  });

  it("EVID-03: the origin-wide mutant fails the same assertion", async () => {
    const env = new FakeWorkerEnv();
    for (const name of EVERYTHING) await env.cacheStorage.seed(name, {});
    await originWideDeletion(env.cacheStorage);
    const remaining = await env.cacheStorage.keys();
    expect(() => assertForeignAndCurrentSurvive(remaining)).toThrow();
    expect(remaining).toEqual([CURRENT]);
  });

  it("survives a Cache Storage that refuses to list or delete", async () => {
    const broken: Pick<CacheStorage, "keys" | "delete"> = {
      keys: () => Promise.reject(new Error("closed")),
      delete: () => Promise.reject(new Error("closed")),
    };
    // SAFETY: cleanup reads only keys() and delete(); the other members are
    // never reached, so the narrowed object stands in for the storage.
    const caches: CacheStorage = Object.assign(Object.create(null), broken);
    await expect(
      cleanupCaches({
        caches,
        scopePath: SCOPE,
        releaseId: "cur",
        retained: new Set(),
      }),
    ).resolves.toEqual([]);
  });
});
