import { afterEach, describe, expect, it } from "vitest";
import {
  openShareTarget,
  shareTargetCacheName,
  shareTargetEntryUrl,
} from "../lib/share-target.js";
import { installCoreWorker } from "./core.js";
import { FakeWorkerEnv } from "./test-env.js";
import { RELEASE_MANIFEST } from "./test-fixtures.js";

const SCOPE = "https://example.test/OpenSesame/";
const CACHE = shareTargetCacheName("/OpenSesame/");

function worker(env: FakeWorkerEnv) {
  installCoreWorker(env.sw, {
    variant: "core-only",
    manifest: RELEASE_MANIFEST,
    caches: env.caches,
    fetch: env.fetch,
  });
}

function post(env: FakeWorkerEnv, form: FormData): Promise<Response | null> {
  return env.fetchEvent(
    new Request(`${SCOPE}share-target`, {
      method: "POST",
      body: form,
      headers: {
        // What a browser sends for an OS-initiated share navigation.
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
      },
    }),
  );
}

afterEach(() => {
  // The fake cache and pending-import slots are per-test objects; nothing else
  // is global here.
});

describe("Web Share Target ingress", () => {
  it("stages one file behind a token and redirects to the app", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const form = new FormData();
    form.set("title", "Deploy keys");
    form.set("text", "shared from a phone");
    form.set(
      "files",
      new File(["API_KEY=sk-test\n"], "app.env", {
        type: "text/plain",
      }),
    );

    const response = await post(env, form);
    expect(response?.status).toBe(303);
    const location = new URL(response?.headers.get("Location") ?? "");
    const [token = "", key = "", createdAt = ""] = (
      new URLSearchParams(location.hash.slice(1)).get("share-target") ?? ""
    ).split(".");
    expect(token).toMatch(/^[0-9a-f-]{36}$/u);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const cache = await env.cacheStorage.open(CACHE);
    const metaResponse = await cache.match(
      shareTargetEntryUrl(SCOPE, token, Number(createdAt), "meta"),
    );
    if (!metaResponse) throw new Error("meta entry missing");
    const meta = JSON.parse(
      new TextDecoder().decode(
        await openShareTarget(
          key,
          new Uint8Array(await metaResponse.arrayBuffer()),
        ),
      ),
    );
    expect(meta).toMatchObject({
      title: "Deploy keys",
      text: "shared from a phone",
      file: { type: "text/plain" },
    });
    expect(
      cache
        .urls()
        .some(
          (url) =>
            url ===
            shareTargetEntryUrl(SCOPE, token, Number(createdAt), "file"),
        ),
    ).toBe(true);
  });

  it("accepts text without a file", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const form = new FormData();
    form.set("text", "a note");
    const response = await post(env, form);
    expect(response?.status).toBe(303);
    const location = new URL(response?.headers.get("Location") ?? "");
    const [token = "", key = "", createdAt = ""] = (
      new URLSearchParams(location.hash.slice(1)).get("share-target") ?? ""
    ).split(".");
    const cache = await env.cacheStorage.open(CACHE);
    const metaResponse = await cache.match(
      shareTargetEntryUrl(SCOPE, token, Number(createdAt), "meta"),
    );
    if (!metaResponse) throw new Error("meta entry missing");
    const meta = JSON.parse(
      new TextDecoder().decode(
        await openShareTarget(
          key,
          new Uint8Array(await metaResponse.arrayBuffer()),
        ),
      ),
    );
    expect(meta).toMatchObject({ text: "a note", file: null });
    expect(cache.urls().some((url) => url.endsWith("/file"))).toBe(false);
  });

  it("refuses more than one file instead of dropping one", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const form = new FormData();
    form.append("files", new File(["one"], "one.env"));
    form.append("files", new File(["two"], "two.env"));
    const response = await post(env, form);
    expect(response?.status).toBe(413);
  });

  it("refuses an empty share", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const response = await post(env, new FormData());
    expect(response?.status).toBe(400);
  });

  it("refuses a cross-origin Origin or Referer even when fetch metadata says none", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const form = new FormData();
    form.set("text", "planted");
    const foreignOrigin = await env.fetchEvent(
      new Request(`${SCOPE}share-target`, {
        method: "POST",
        body: form,
        headers: {
          origin: "https://evil.test",
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
        },
      }),
    );
    expect(foreignOrigin?.status).toBe(403);
    const planted = new FormData();
    planted.set("text", "planted");
    const foreignReferer = await env.fetchEvent(
      new Request(`${SCOPE}share-target`, {
        method: "POST",
        body: planted,
        headers: {
          referer: "https://evil.test/page",
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
        },
      }),
    );
    expect(foreignReferer?.status).toBe(403);
    const cache = await env.cacheStorage.open(CACHE);
    expect(cache.urls()).toEqual([]);
  });

  it("refuses a share with missing or same-site fetch metadata", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const cases: Array<Record<string, string>> = [
      {},
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
    ];
    for (const headers of cases) {
      const form = new FormData();
      form.set("text", "planted");
      const response = await env.fetchEvent(
        new Request(`${SCOPE}share-target`, {
          method: "POST",
          body: form,
          headers,
        }),
      );
      expect(response?.status).toBe(403);
    }
    const cache = await env.cacheStorage.open(CACHE);
    expect(cache.urls()).toEqual([]);
  });

  it("sweeps expired and malformed staged ciphertext on any share attempt", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const longAgo = Date.now() - 2 * 60 * 60 * 1000;
    const stale = shareTargetEntryUrl(
      SCOPE,
      "00000000-0000-4000-8000-000000000001",
      longAgo,
      "meta",
    );
    const malformed = new URL(
      `${new URL(SCOPE).pathname}__share-target/token/not-a-time/meta`,
      SCOPE,
    ).href;
    await env.cacheStorage.seed(CACHE, { [stale]: "old", [malformed]: "bad" });
    const response = await post(env, new FormData());
    expect(response?.status).toBe(400);
    const cache = await env.cacheStorage.open(CACHE);
    expect(cache.urls()).toEqual([]);
  });

  it("sweeps abandoned ciphertext at worker activation", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const longAgo = Date.now() - 2 * 60 * 60 * 1000;
    const stale = shareTargetEntryUrl(
      SCOPE,
      "00000000-0000-4000-8000-000000000002",
      longAgo,
      "meta",
    );
    await env.cacheStorage.seed(CACHE, { [stale]: "old" });
    await env.activate();
    const cache = await env.cacheStorage.open(CACHE);
    expect(cache.urls()).toEqual([]);
  });

  it("leaves ordinary POSTs to the normal fetch path", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const response = await env.fetchEvent(
      new Request(`${SCOPE}other`, { method: "POST", body: "x" }),
    );
    expect(response).toBeNull();
  });
});
