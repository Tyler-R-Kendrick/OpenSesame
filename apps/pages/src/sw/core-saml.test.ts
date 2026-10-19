import { assertSamlPostOwner as protocolOwnerGuard } from "@opensesame/app-core/browser/saml/assertion-conditions.js";
import { assertSamlPostOwner as callbackOwnerGuard } from "@opensesame/app-core/browser/saml/post-wire.js";
import { describe, expect, it } from "vitest";
import { installCoreWorker } from "./core.js";
import { FakeWorkerEnv } from "./test-env.js";
import { RELEASE_MANIFEST } from "./test-fixtures.js";

const callback = "assets/native-saml-aB3dE5gH.js";
function installed(assets: readonly string[], variant = "core-only") {
  const env = new FakeWorkerEnv();
  installCoreWorker(env.sw, {
    variant,
    manifest: [...RELEASE_MANIFEST, ...assets],
    caches: env.caches,
    fetch: env.fetch,
  });
  return env;
}
const post = (env: FakeWorkerEnv, path = "auth/native-saml") =>
  env.fetchEvent(new Request(new URL(path, env.scope), { method: "POST" }));

describe("release-owned native SAML worker routing", () => {
  it.each(["core-only", "push"])(
    "enables exact POST custody in the %s variant only when its callback ships",
    async (variant) => {
      const env = installed([callback], variant);
      // This worker unit fixture has no resultingClientId. Only the actual
      // browser journey proves successful custody; an unowned event must fail.
      expect((await post(env))?.status).toBe(409);
    },
  );
  it("leaves ordinary POST handling untouched when the callback capability is absent", async () => {
    expect(await post(installed([]))).toBeNull();
  });
  it("refuses a callback GET or refresh instead of booting the application shell", async () => {
    const env = installed([callback]);
    const response = await env.fetchEvent(
      new Request(new URL("auth/native-saml", env.scope)),
    );
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.text()).not.toContain("<script");
    expect(env.fetched).toEqual([]);
  });
  it.each([
    "auth/native-saml/",
    "auth/native-saml?response=unrequested",
    "other/auth/native-saml",
  ])("does not intercept ACS lookalike %s", async (path) => {
    expect(await post(installed([callback]), path)).toBeNull();
  });
  it("rejects ambiguous callback assets instead of selecting a stale release", () => {
    expect(() =>
      installed([callback, "assets/native-saml-zY7wV5uT.js"]),
    ).toThrow("ambiguous");
  });
  it("never treats an external or traversal lookalike as its callback asset", async () => {
    const env = installed([
      `https://foreign.test/${callback}`,
      `../${callback}`,
    ]);
    expect(await post(env)).toBeNull();
  });
});

it("derives the exact protocol owner guard and refuses an aborted owner before invoking its assertion", () => {
  expect(callbackOwnerGuard).toBe(protocolOwnerGuard);
  const stop = new AbortController();
  let calls = 0;
  const owner = {
    signal: stop.signal,
    assertCurrent() {
      calls += 1;
    },
  };
  callbackOwnerGuard(owner);
  expect(calls).toBe(1);
  stop.abort();
  expect(() => callbackOwnerGuard(owner)).toThrow();
  expect(calls).toBe(1);
});
