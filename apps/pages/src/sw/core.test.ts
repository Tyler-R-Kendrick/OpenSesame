import { describe, expect, it } from "vitest";
import { cacheName } from "./cache-names.js";
import { installCoreWorker } from "./core.js";
import { installPushHandlers } from "./push-handlers.js";
import { FakeWorkerEnv, navigateTo } from "./test-env.js";
import { RELEASE_ID, RELEASE_MANIFEST } from "./test-fixtures.js";

const SCOPE_PATH = "/OpenSesame/";
const CURRENT = cacheName(SCOPE_PATH, RELEASE_ID, "core-only");
const OLD = cacheName(SCOPE_PATH, "old000", "core-only");
const OLD_STAGING = cacheName(SCOPE_PATH, "old000", "staging");
const FOREIGN_APP = "other-app-cache";
const FOREIGN_SCOPE = cacheName("/other-scope/", "zzz", "core-only");

function coreWorker(env: FakeWorkerEnv) {
  return installCoreWorker(env.sw, {
    variant: "core-only",
    manifest: RELEASE_MANIFEST,
    caches: env.caches,
    fetch: env.fetch,
  });
}

describe("core worker listener table (PWA-01)", () => {
  it("registers no push or notificationclick handler", () => {
    const env = new FakeWorkerEnv();
    coreWorker(env);
    expect(env.listenerTypes()).toEqual([
      "activate",
      "fetch",
      "install",
      "message",
    ]);
  });

  it("the push variant adds exactly the two push handlers", () => {
    const env = new FakeWorkerEnv();
    installCoreWorker(env.sw, {
      variant: "push",
      manifest: RELEASE_MANIFEST,
      caches: env.caches,
      fetch: env.fetch,
    });
    installPushHandlers(env.sw);
    expect(env.listenerTypes()).toEqual([
      "activate",
      "fetch",
      "install",
      "message",
      "notificationclick",
      "push",
    ]);
  });
});

describe("install", () => {
  it("precaches only the shell into the release cache and skips waiting", async () => {
    const env = new FakeWorkerEnv();
    const shell = env.serve("index.html", "SHELL");
    env.serve("assets/main-abc.js", "js");
    const worker = coreWorker(env);
    await env.install();
    expect(worker.ctx.releaseId).toBe(RELEASE_ID);
    expect(worker.ctx.releaseCacheName).toBe(CURRENT);
    expect(env.fetched).toEqual([shell]);
    const cache = await env.cacheStorage.open(CURRENT);
    expect(cache.urls()).toEqual([shell]);
    expect(env.skipWaitingCalls).toBe(1);
  });

  it("does not fail install when the shell cannot be saved", async () => {
    const env = new FakeWorkerEnv();
    env.offline("index.html");
    coreWorker(env);
    await expect(env.install()).resolves.toBeUndefined();
    expect(env.skipWaitingCalls).toBe(1);
  });
});

describe("activate cleanup (PWA-04)", () => {
  async function seeded(): Promise<FakeWorkerEnv> {
    const env = new FakeWorkerEnv();
    await env.cacheStorage.seed(FOREIGN_APP, { "https://example.test/x": "x" });
    await env.cacheStorage.seed(FOREIGN_SCOPE, {
      "https://example.test/other-scope/index.html": "o",
    });
    await env.cacheStorage.seed(OLD, {
      "https://example.test/OpenSesame/index.html": "OLD SHELL",
    });
    await env.cacheStorage.seed(OLD_STAGING, {});
    await env.cacheStorage.seed(CURRENT, {});
    return env;
  }

  it("deletes only this scope's other releases when no window is open", async () => {
    const env = await seeded();
    coreWorker(env);
    await env.activate();
    expect((await env.cacheStorage.keys()).sort()).toEqual(
      [FOREIGN_APP, FOREIGN_SCOPE, CURRENT].sort(),
    );
    expect(env.cacheStorage.deleted.sort()).toEqual([OLD, OLD_STAGING].sort());
    expect(env.clients.claimed).toBe(1);
  });

  it("retains older releases while a window from before the takeover is open", async () => {
    const env = await seeded();
    const stale = env.clients.add({
      id: "w1",
      url: "https://example.test/OpenSesame/vault",
      controlled: false,
    });
    const worker = coreWorker(env);
    await env.activate();
    expect(await env.cacheStorage.has(OLD)).toBe(true);
    expect(await env.cacheStorage.has(OLD_STAGING)).toBe(true);
    expect(worker.retained.has("old000")).toBe(true);

    // The same window says hello: still open, so still retained.
    await env.message(stale, { type: "WORKER_HELLO" });
    expect(await env.cacheStorage.has(OLD)).toBe(true);
    expect(stale.messages).toEqual([
      {
        type: "WORKER_INFO",
        releaseId: RELEASE_ID,
        variant: "core-only",
        scopePath: SCOPE_PATH,
      },
    ]);

    // It reloads: a new client id arrives, the old one is gone.
    env.clients.remove("w1");
    const fresh = env.clients.add({
      id: "w2",
      url: "https://example.test/OpenSesame/",
    });
    await env.message(fresh, { type: "WORKER_HELLO" });
    expect(await env.cacheStorage.has(OLD)).toBe(false);
    expect(await env.cacheStorage.has(OLD_STAGING)).toBe(false);
    expect(await env.cacheStorage.has(FOREIGN_APP)).toBe(true);
    expect(await env.cacheStorage.has(FOREIGN_SCOPE)).toBe(true);
    expect(await env.cacheStorage.has(CURRENT)).toBe(true);
  });

  it("ignores a hello from a window outside the scope", async () => {
    const env = await seeded();
    coreWorker(env);
    await env.activate();
    const outsider = env.clients.add({
      id: "o1",
      url: "https://example.test/other-scope/",
    });
    await env.message(outsider, { type: "WORKER_HELLO" });
    expect(outsider.messages).toEqual([]);
  });

  it("ignores every unknown message type", async () => {
    const env = await seeded();
    coreWorker(env);
    await env.activate();
    const page = env.clients.add({ id: "p", url: env.scope });
    await env.message(page, { type: "DELETE_CACHES" });
    await env.message(page, { type: "SKIP_WAITING" });
    await env.message(page, "PLAN_ASSETS");
    expect(page.messages).toEqual([]);
    expect(env.fetched).toEqual([]);
  });
});

describe("fetch routing (PWA-08)", () => {
  it("serves an offline navigation from its own shell, never an older release's", async () => {
    const env = new FakeWorkerEnv();
    const shellUrl = new URL("index.html", env.scope).href;
    await env.cacheStorage.seed(OLD, { [shellUrl]: "OLD SHELL" });
    env.offline("index.html");
    env.offline("vault/items");
    coreWorker(env);
    // Nothing of this release saved yet: the older shell must not answer.
    await expect(
      env.fetchEvent(navigateTo(new URL("vault/items", env.scope).href)),
    ).rejects.toThrow(/offline shell unavailable/);
    // Now this release holds its shell.
    const own = await env.cacheStorage.open(CURRENT);
    await own.put(shellUrl, new Response("NEW SHELL"));
    const response = await env.fetchEvent(
      navigateTo(new URL("vault/items", env.scope).href),
    );
    expect(await response?.text()).toBe("NEW SHELL");
    expect(response?.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin",
    );
    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe(
      "require-corp",
    );
  });

  it("network-first navigation refreshes the release shell on a 404 deep link", async () => {
    const env = new FakeWorkerEnv();
    env.serve("index.html", "NET SHELL");
    coreWorker(env);
    const response = await env.fetchEvent(
      navigateTo(new URL("settings/vaults", env.scope).href),
    );
    expect(await response?.text()).toBe("NET SHELL");
    const own = await env.cacheStorage.open(CURRENT);
    expect(own.urls()).toEqual([new URL("index.html", env.scope).href]);
  });

  it("answers os-runtime-config.json network-first and from its cache offline", async () => {
    const env = new FakeWorkerEnv();
    const url = env.serve("os-runtime-config.json", '{"a":1}');
    coreWorker(env);
    const first = await env.fetchEvent(new Request(url));
    expect(await first?.text()).toBe('{"a":1}');
    env.offline("os-runtime-config.json");
    const second = await env.fetchEvent(new Request(url));
    expect(await second?.text()).toBe('{"a":1}');
  });

  it("does not cache an arbitrary same-origin asset it merely proxied", async () => {
    const env = new FakeWorkerEnv();
    const url = env.serve("assets/random-999.js", "js");
    coreWorker(env);
    const response = await env.fetchEvent(new Request(url));
    expect(await response?.text()).toBe("js");
    const own = await env.cacheStorage.open(CURRENT);
    expect(own.urls()).toEqual([]);
  });

  it("leaves cross-origin and non-GET requests alone", async () => {
    const env = new FakeWorkerEnv();
    coreWorker(env);
    expect(await env.fetchEvent(new Request("https://cdn.test/x.js"))).toBe(
      null,
    );
    expect(
      await env.fetchEvent(new Request(env.scope, { method: "POST" })),
    ).toBe(null);
  });
});
