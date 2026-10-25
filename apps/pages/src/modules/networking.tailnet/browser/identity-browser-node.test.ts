/** @vitest-environment node */
// Real Node Worker + verified HTTPS at the existing SDK boundary; not Go/WASM enrollment.
import { createNativeOidcAdmissionRuntime } from "@opensesame/app-core/browser/oidc/admission.js";
import { consumeNativeOidcProof } from "@opensesame/app-core/browser/oidc/claims.js";
import { prepareConfiguredOidc } from "@opensesame/app-core/browser/oidc/transaction.js";
import { readNativeFederationSession } from "@opensesame/app-core/lib/federation-native-session.js";
import { readFederationSessionJson } from "@opensesame/app-core/lib/federation-session-store.js";
import {
  type IdentityBrowserNode,
  bindIdentityBrowserNodeFactory,
} from "@opensesame/app-core/lib/tailscale/browser-node-identity-port.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { expect, it, vi } from "vitest";
import { identityNodeFixture } from "./identity-node.test-support.js";
import { HostMessage } from "./protocol.js";
it("one explicit memory Worker consumes independently signed confidential/org OIDC without browser fetch or persistent node keys", async () => {
  const f = await identityNodeFixture();
  await f.connect();
  const port = f.node.captureNativeHTTP(f.original.signal);
  const callback =
    "https://pwa.example.test/OpenSesame/auth/native-connector.html";
  const attempt = await prepareConfiguredOidc(
    f.idp.config,
    callback,
    port,
    f.original,
  );
  f.idp.authorize(attempt.authorizationUrl);
  const proof = await attempt.complete({
    state: attempt.state,
    code: "independent-once",
    error: false,
  });
  const current = createNativeOidcAdmissionRuntime();
  const before = vaultStore.getSnapshot();
  let retired = false;
  try {
    const identity = await current.admit(proof, {
      connectionId: "original-worker-oidc",
      label: "Original independent HTTPS identity",
      assertSessionCurrent(claims) {
        f.original.assertCurrent();
        expect(claims).toMatchObject({
          issuer: f.idp.config.issuer,
          audience: f.idp.config.clientId,
          subject: "owned-person",
          organizationId: "org_actual",
        });
      },
      async retireProtocol() {
        f.original.assertCurrent();
        await vi.waitFor(() =>
          expect(
            f.thread.diagnostics.filter(
              (entry) => entry.fixture === "wire-closed",
            ),
          ).toHaveLength(f.idp.requests.length),
        );
        expect(await f.node.stop()).toBe(true);
        await f.thread.exit;
        f.original.assertCurrent();
        retired = true;
      },
    });
    expect(retired).toBe(true);
    expect(identity).toMatchObject({
      assertionFormat: "native-oidc",
      issuer: f.idp.config.issuer,
      audience: f.idp.config.clientId,
      pairwiseSub: "owned-person",
      idToken: "",
      jwksUri: "",
    });
    expect(readNativeFederationSession()).toBe(identity);
    expect(readFederationSessionJson()).toBeNull();
    expect(vaultStore.getSnapshot()).toBe(before);
  } finally {
    current.dispose();
  }
  expect(() => consumeNativeOidcProof(proof)).toThrow(/consumed/);
  expect(f.idp.errors).toEqual([]);
  expect(
    f.idp.requests.filter((entry) => entry.path.endsWith("/token")),
  ).toHaveLength(1);
  expect(f.idp.requests.some((entry) => entry.path.endsWith("/jwks"))).toBe(
    true,
  );
  expect(
    f.thread.messages.some((entry) => {
      const parsed = HostMessage.safeParse(entry);
      return parsed.success && parsed.data.kind === "storage";
    }),
  ).toBe(false);
  expect(f.browserFetch).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(
      f.thread.diagnostics.filter((entry) => entry.fixture === "wire-closed"),
    ).toHaveLength(f.idp.requests.length),
  );
  expect(await f.node.stop()).toBe(true);
  await f.thread.exit;
});
it("held caller cancellation physically closes TLS within two seconds and preserves the original Worker for the next request", async () => {
  const f = await identityNodeFixture();
  await f.connect();
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let entered: () => void = () => undefined;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  f.idp.observe(() => entered());
  f.idp.beforeResponse(() => held);
  const caller = new AbortController();
  const port = f.node.captureNativeHTTP(caller.signal);
  let settled = false;
  const url = `${f.idp.config.issuer}/.well-known/openid-configuration`;
  const request = port.fetch(url).finally(() => {
    settled = true;
  });
  const rejected = expect(request).rejects.toThrow();
  try {
    await Promise.race([
      ready,
      request.then(() => {
        throw new Error("Held request completed before the fixture entered.");
      }),
    ]);
    await new Promise((done) => setTimeout(done, 250));
    expect(settled).toBe(false);
    const abortedAt = performance.now();
    caller.abort();
    await rejected;
    await vi.waitFor(
      () => expect(f.idp.closed).toContain(new URL(url).pathname),
      { timeout: 1900, interval: 10 },
    );
    expect(performance.now() - abortedAt).toBeLessThan(2000);
  } finally {
    f.idp.beforeResponse(null);
    release();
  }
  const next = await f.node.captureNativeHTTP(f.original.signal).fetch(url);
  expect(next.status).toBe(200);
  expect(f.node.snapshot().status).toBe("connected");
  expect(
    f.thread.diagnostics.filter((entry) => entry.fixture === "explicit-login"),
  ).toHaveLength(1);
  await vi.waitFor(() =>
    expect(
      f.thread.diagnostics.filter((entry) => entry.fixture === "wire-closed"),
    ).toHaveLength(2),
  );
  expect(await f.node.stop()).toBe(true);
  await f.thread.exit;
  expect(f.browserFetch).not.toHaveBeenCalled();
});
it("current Networking withdrawal refuses before any private body reaches the original TLS server", async () => {
  const f = await identityNodeFixture();
  await f.connect();
  const port = f.node.captureNativeHTTP(f.original.signal);
  f.withdrawPolicy();
  let privateBodyReads = 0;
  await expect(
    port.fetch(`${f.idp.config.issuer}/token`, {
      method: "POST",
      get body() {
        privateBodyReads++;
        return "private-not-sent";
      },
    }),
  ).rejects.toThrow(/Approve/);
  expect(privateBodyReads).toBe(0);
  expect(f.idp.requests).toEqual([]);
  expect(f.browserFetch).not.toHaveBeenCalled();
});
it("original self-key replacement retires the Worker and never lets its held port adopt a successor", async () => {
  const f = await identityNodeFixture();
  await f.connect();
  const port = f.node.captureNativeHTTP(f.original.signal);
  f.thread.raw.postMessage({ fixture: "replace-self" });
  await vi.waitFor(() => expect(f.thread.raw.threadId).toBe(-1));
  expect(() => port.assertCurrent()).toThrow();
  expect(f.idp.requests).toEqual([]);
  expect(f.browserFetch).not.toHaveBeenCalled();
});
it("original activation replacement cannot silently reacquire another factory", async () => {
  const f = await identityNodeFixture();
  const replacement = vi.fn<() => IdentityBrowserNode>(() => {
    throw new Error("Replacement must not be consulted");
  });
  const release = bindIdentityBrowserNodeFactory(replacement);
  release();
  expect(() => f.node.start(f.configuration)).toThrow();
  expect(replacement).not.toHaveBeenCalled();
  expect(f.idp.requests).toEqual([]);
  await f.thread.raw.terminate();
});

it("captured original owner method replacement refuses before starting any SDK operation", async () => {
  const f = await identityNodeFixture();
  const replacement = vi.fn();
  f.original.assertCurrent = replacement;
  expect(() => f.node.start(f.configuration)).toThrow(/owner changed/);
  expect(replacement).not.toHaveBeenCalled();
  expect(f.idp.requests).toEqual([]);
  await f.thread.raw.terminate();
});
