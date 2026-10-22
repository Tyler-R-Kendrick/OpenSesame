import { afterEach, describe, expect, it } from "vitest";
import { shareTargetCacheName } from "../lib/share-target.js";
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
    new Request(`${SCOPE}share-target`, { method: "POST", body: form }),
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
    const token = location.searchParams.get("share-target");
    expect(token).toMatch(/^[0-9a-f-]{36}$/u);
    const cache = await env.cacheStorage.open(CACHE);
    const entry = cache.urls().find((url) => url.endsWith("/meta"));
    expect(entry).toBeDefined();
    const metaResponse = await cache.match(entry ?? "");
    const meta = await metaResponse?.json();
    expect(meta).toMatchObject({
      title: "Deploy keys",
      text: "shared from a phone",
      file: { type: "text/plain" },
    });
    expect(cache.urls().some((url) => url.endsWith("/file"))).toBe(true);
  });

  it("accepts text without a file", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const form = new FormData();
    form.set("text", "a note");
    const response = await post(env, form);
    expect(response?.status).toBe(303);
    const cache = await env.cacheStorage.open(CACHE);
    const entry = cache.urls().find((url) => url.endsWith("/meta"));
    const meta = await (await cache.match(entry ?? ""))?.json();
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

  it("leaves ordinary POSTs to the normal fetch path", async () => {
    const env = new FakeWorkerEnv(SCOPE);
    worker(env);
    const response = await env.fetchEvent(
      new Request(`${SCOPE}other`, { method: "POST", body: "x" }),
    );
    expect(response).toBeNull();
  });
});
