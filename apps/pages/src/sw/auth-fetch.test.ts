import { describe, expect, it } from "vitest";
import { installCoreWorker } from "./core.js";
import { FakeWorkerEnv, navigateTo } from "./test-env.js";
import { RELEASE_MANIFEST } from "./test-fixtures.js";

const pages = [
  "linear.html",
  "native-connector.html",
  "native-implicit.html",
  "native-google.html",
  "redirect.html",
];

async function installed(scope = "https://example.test/OpenSesame/") {
  const env = new FakeWorkerEnv(scope);
  const requests: Request[] = [];
  env.serve("index.html", "OFFLINE APP SHELL");
  const worker = installCoreWorker(env.sw, {
    variant: "core-only",
    manifest: RELEASE_MANIFEST,
    caches: env.caches,
    fetch: (input) => {
      if (input instanceof Request) requests.push(input);
      return env.fetch(input);
    },
  });
  await env.install();
  const cache = await env.cacheStorage.open(worker.ctx.releaseCacheName);
  return { env, cache, requests, shellUrl: worker.ctx.shellUrl };
}

describe.each(pages)("network-only auth page %s", (page) => {
  it("returns the actual callback with isolation headers without replacing the shell", async () => {
    const { env, cache, requests, shellUrl } = await installed();
    const uri = `auth/${page}?state=owned&code=single-use`;
    const url = env.serve(uri, "AUTH DOCUMENT");
    const response = await env.fetchEvent(navigateTo(url));
    expect(await response?.text()).toBe("AUTH DOCUMENT");
    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe(
      "require-corp",
    );
    expect(response?.headers.get("Cross-Origin-Opener-Policy")).toBe(
      page === "redirect.html" ? null : "same-origin",
    );
    expect(cache.urls()).toEqual([shellUrl]);
    expect(requests[0]?.cache).toBe("no-store");
    env.offline("vault");
    expect(
      await (
        await env.fetchEvent(navigateTo(new URL("vault", env.scope).href))
      )?.text(),
    ).toBe("OFFLINE APP SHELL");
  });

  it("returns a real 404 without fetching or serving the shell", async () => {
    const { env, cache, shellUrl } = await installed();
    const url = new URL(`auth/${page}`, env.scope).href;
    const response = await env.fetchEvent(navigateTo(url));
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("not found");
    expect(env.fetched).toEqual([shellUrl, url]);
    expect(await (await cache.match(shellUrl))?.text()).toBe(
      "OFFLINE APP SHELL",
    );
  });

  it("fails offline even when an old callback is present in the release cache", async () => {
    const { env, cache, shellUrl } = await installed();
    const uri = `auth/${page}`;
    const url = new URL(uri, env.scope).href;
    await cache.put(url, new Response("STALE CALLBACK"));
    env.offline(uri);
    await expect(env.fetchEvent(navigateTo(url))).rejects.toThrow(
      "Failed to fetch",
    );
    await expect(env.fetchEvent(new Request(url))).rejects.toThrow(
      "Failed to fetch",
    );
    expect(await (await cache.match(shellUrl))?.text()).toBe(
      "OFFLINE APP SHELL",
    );
  });
});

it("matches auth pages within the exact registration scope, including a root deployment", async () => {
  const { env, shellUrl } = await installed("https://example.test/");
  const auth = env.serve("auth/linear.html", "ROOT AUTH");
  expect(await (await env.fetchEvent(navigateTo(auth)))?.text()).toBe(
    "ROOT AUTH",
  );
  const ordinary = env.serve("linear.html", "ORDINARY DOCUMENT");
  await env.fetchEvent(navigateTo(ordinary));
  env.offline("vault");
  expect(
    await (
      await env.fetchEvent(navigateTo(new URL("vault", env.scope).href))
    )?.text(),
  ).toBe("ORDINARY DOCUMENT");
  expect(env.fetched).toContain(shellUrl);
});
