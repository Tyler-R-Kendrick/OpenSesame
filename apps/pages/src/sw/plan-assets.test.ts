import { describe, expect, it } from "vitest";
import { cacheName, stagingCacheName } from "./cache-names.js";
import { installCoreWorker } from "./core.js";
import { GRAPH_FILE } from "./plan-assets.js";
import { type FakeClient, FakeWorkerEnv } from "./test-env.js";
import {
  ALL_FIXTURE_FILES,
  CONNECTORS_MODULE,
  CONNECTORS_PLAN_FILES,
  EXCLUDED_JS,
  FIXTURE_GRAPH,
  PLAN_DIGEST,
  RELEASE_ID,
  RELEASE_MANIFEST,
  SHARED_JS,
} from "./test-fixtures.js";

const SCOPE_PATH = "/OpenSesame/";
const CURRENT = cacheName(SCOPE_PATH, RELEASE_ID, "core-only");
const STAGING = stagingCacheName(SCOPE_PATH, RELEASE_ID);
const PREVIOUS = cacheName(SCOPE_PATH, "prev00", "core-only");

type Ready = Readonly<{ env: FakeWorkerEnv; page: FakeClient; shell: string }>;

/** An installed, activated core worker with one controlled window. */
async function ready(): Promise<Ready> {
  const env = new FakeWorkerEnv();
  const shell = env.serve("index.html", "SHELL");
  env.serve(GRAPH_FILE, JSON.stringify(FIXTURE_GRAPH));
  for (const file of ALL_FIXTURE_FILES) env.serve(file, `body of ${file}`);
  installCoreWorker(env.sw, {
    variant: "core-only",
    manifest: RELEASE_MANIFEST,
    caches: env.caches,
    fetch: env.fetch,
  });
  await env.install();
  await env.activate();
  const page = env.clients.add({ id: "page", url: env.scope });
  env.fetched.length = 0;
  return { env, page, shell };
}

function plan(moduleIds: readonly string[], releaseId = RELEASE_ID) {
  return { type: "PLAN_ASSETS", releaseId, planDigest: PLAN_DIGEST, moduleIds };
}

function abs(env: FakeWorkerEnv, file: string): string {
  return new URL(file, env.scope).href;
}

describe("PLAN_ASSETS caches only the plan's chunks (PWA-05)", () => {
  it("saves the module chunk, its static closure, its CSS and the core entry", async () => {
    const { env, page, shell } = await ready();
    await env.message(page, plan([CONNECTORS_MODULE]));
    expect(page.messages).toEqual([
      { type: "OFFLINE_READY", releaseId: RELEASE_ID, planDigest: PLAN_DIGEST },
    ]);
    const own = await env.cacheStorage.open(CURRENT);
    expect(own.urls()).toEqual(
      [
        shell,
        abs(env, GRAPH_FILE),
        ...CONNECTORS_PLAN_FILES.map((f) => abs(env, f)),
      ].sort(),
    );
    expect(env.fetched).not.toContain(abs(env, EXCLUDED_JS));
    expect(await env.cacheStorage.has(STAGING)).toBe(false);
  });

  it("does not fetch again what the release cache already holds", async () => {
    const { env, page } = await ready();
    await env.message(page, plan([CONNECTORS_MODULE]));
    const before = env.fetched.length;
    await env.message(page, plan([CONNECTORS_MODULE]));
    // Only the graph is re-read; every asset was already saved.
    expect(env.fetched.slice(before)).toEqual([abs(env, GRAPH_FILE)]);
    expect(page.messages.at(-1)).toEqual({
      type: "OFFLINE_READY",
      releaseId: RELEASE_ID,
      planDigest: PLAN_DIGEST,
    });
  });

  it("an empty plan still saves the core entry chunks", async () => {
    const { env, page, shell } = await ready();
    await env.message(page, plan([]));
    const own = await env.cacheStorage.open(CURRENT);
    expect(own.urls()).toEqual(
      [
        shell,
        abs(env, GRAPH_FILE),
        abs(env, "assets/main-abc.js"),
        abs(env, "assets/main-abc.css"),
        abs(env, "assets/vendor-111.js"),
      ].sort(),
    );
  });
});

describe("readiness protocol (PWA-07)", () => {
  it("a partial download reports the count and leaves both caches intact", async () => {
    const { env, page, shell } = await ready();
    const previousShell = abs(env, "index.html");
    await env.cacheStorage.seed(PREVIOUS, { [previousShell]: "PREVIOUS" });
    env.offline(SHARED_JS);
    await env.message(page, plan([CONNECTORS_MODULE]));
    expect(page.messages).toEqual([
      {
        type: "OFFLINE_PARTIAL",
        releaseId: RELEASE_ID,
        planDigest: PLAN_DIGEST,
        missing: 1,
      },
    ]);
    const own = await env.cacheStorage.open(CURRENT);
    expect(own.urls()).toEqual([shell, abs(env, GRAPH_FILE)].sort());
    const previous = await env.cacheStorage.open(PREVIOUS);
    expect(await (await previous.match(previousShell))?.text()).toBe(
      "PREVIOUS",
    );
    expect(await env.cacheStorage.has(STAGING)).toBe(false);
  });

  it("a quota refusal is reported as storage unavailable, never thrown", async () => {
    const { env, page } = await ready();
    env.quotaBytes = 40;
    await expect(
      env.message(page, plan([CONNECTORS_MODULE])),
    ).resolves.toBeUndefined();
    expect(page.messages).toEqual([
      {
        type: "OFFLINE_STORAGE_UNAVAILABLE",
        releaseId: RELEASE_ID,
        planDigest: PLAN_DIGEST,
      },
    ]);
    expect(await env.cacheStorage.has(STAGING)).toBe(false);
  });

  it("falls back to the graph saved under this release when the network is gone", async () => {
    const { env, page } = await ready();
    await env.message(page, plan([]));
    env.offline(GRAPH_FILE);
    await env.message(page, plan([CONNECTORS_MODULE]));
    expect(page.messages.at(-1)?.type).toBe("OFFLINE_READY");
  });
});

describe("forged messages are refused (PWA-09)", () => {
  it("rejects a plan for another release without touching the network or storage", async () => {
    const { env, page } = await ready();
    await env.message(page, plan([CONNECTORS_MODULE], "someother"));
    expect(page.messages).toEqual([
      { type: "PLAN_REJECTED", reason: "release-mismatch" },
    ]);
    expect(env.fetched).toEqual([]);
    expect(env.cacheStorage.deleted).toEqual([]);
  });

  it("rejects URLs wherever they hide", async () => {
    const { env, page } = await ready();
    await env.message(page, plan(["https://evil.test/steal.js"]));
    await env.message(page, plan(["/OpenSesame/assets/main-abc.js"]));
    await env.message(page, plan(["assets/main-abc.js"]));
    await env.message(page, {
      ...plan([]),
      urls: ["https://evil.test/steal.js"],
    });
    expect(page.messages).toEqual([
      { type: "PLAN_REJECTED", reason: "carries-url" },
      { type: "PLAN_REJECTED", reason: "carries-url" },
      { type: "PLAN_REJECTED", reason: "carries-url" },
      { type: "PLAN_REJECTED", reason: "malformed" },
    ]);
    expect(env.fetched).toEqual([]);
    expect(env.cacheStorage.deleted).toEqual([]);
  });

  it("rejects ids the graph does not know after reading only the graph", async () => {
    const { env, page } = await ready();
    await env.message(page, plan(["identity.siop/runtime"]));
    expect(page.messages).toEqual([
      { type: "PLAN_REJECTED", reason: "unknown-module" },
    ]);
    expect(env.fetched).toEqual([abs(env, GRAPH_FILE)]);
    expect(env.cacheStorage.deleted).toEqual([]);
  });

  it("drops a plan from an uncontrolled, foreign-scope or non-window client silently", async () => {
    const { env } = await ready();
    const uncontrolled = env.clients.add({
      id: "u",
      url: env.scope,
      controlled: false,
    });
    const foreign = env.clients.add({
      id: "f",
      url: "https://example.test/other-scope/",
    });
    const worker = env.clients.add({
      id: "k",
      url: env.scope,
      type: "worker",
    });
    for (const sender of [uncontrolled, foreign, worker]) {
      await env.message(sender, plan([CONNECTORS_MODULE]));
      expect(sender.messages).toEqual([]);
    }
    await env.message(null, plan([CONNECTORS_MODULE]));
    expect(env.fetched).toEqual([]);
    expect(env.cacheStorage.deleted).toEqual([]);
  });
});
