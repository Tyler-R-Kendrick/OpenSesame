/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { forgetAtRestKeyForTest } from "../../lib/at-rest/key.js";
import { advanceAuthGeneration } from "../../lib/auth-generation.js";
import { SETTINGS_PERSIST_KEY } from "../../lib/capability-connector-scope.js";
import { configuredIdentitySessionTrusted } from "../../lib/federation-configured-token.js";
import { readNativeFederationSession } from "../../lib/federation-native-session.js";
import {
  readStoredSessionSync,
  restoreAuthenticatedSession,
} from "../../lib/federation-restoration.js";
import { readFederationSessionJson } from "../../lib/federation-session-store.js";
import { loadSession, saveSession } from "../../lib/federation.js";
import {
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
  writeIdentityConnection,
} from "../../lib/identity-connections-store.js";
import { kvFlush, kvForgetAll, kvGet, kvHydrate } from "../../lib/kv.js";
import { fixture } from "../../lib/origin-file-publication-custody.test-support.js";
import { localVaultSessionGuard } from "../../lib/secret-backends/local-vault-port.js";
import { vaultStore } from "../../lib/vault/store.js";
import { type NativeOidcProof, consumeNativeOidcProof } from "./claims.js";
import {
  callback,
  hold,
  localCeremony,
  material,
  protocol,
  runtime,
  saveAdapter,
} from "./oidc.test-support.js";
import { prepareConfiguredOidc } from "./transaction.js";

const target = {
  connectionId: "owned_adapter",
  label: "Owned TLS identity",
  assertSessionCurrent() {},
};
it("refuses counterfeit scalar proof without changing canonical vault, native session or persisted token", async () => {
  const before = vaultStore.getSnapshot();
  // SAFETY: Negative proof-boundary probe; decoded JSON has no verifier-owned WeakMap entry.
  const forged = JSON.parse(
    '{"issuer":"fake","subject":"fake"}',
  ) as NativeOidcProof;
  await expect(runtime().admit(forged, target)).rejects.toThrow(/Unknown/);
  expect(vaultStore.getSnapshot()).toBe(before);
  expect(readNativeFederationSession()).toBeNull();
  expect(readFederationSessionJson()).toBeNull();
});
it.each(["client_secret_basic", "client_secret_post", "none"])(
  "%s signed TLS evidence is spent once, retires original route, and cannot create an empty vault",
  async (method) => {
    const p = await protocol(method);
    const request = vi.spyOn(globalThis, "fetch");
    const proof = await p.complete();
    const current = runtime();
    const before = vaultStore.getSnapshot();
    const identity = await current.admit(proof, {
      ...target,
      retireProtocol: async () => {
        p.stop.abort();
      },
    });
    expect(identity).toMatchObject({
      assertionFormat: "native-oidc",
      pairwiseSub: "owned-person",
      idToken: "",
      jwksUri: "",
      issuer: p.idp.config.issuer,
    });
    expect(readNativeFederationSession()).toBe(identity);
    expect(vaultStore.getSnapshot()).toBe(before);
    expect(before.status).toBe("empty");
    expect(p.captures()).toBe(1);
    expect(p.stop.signal.aborted).toBe(true);
    expect(() => p.transport.assertCurrent()).toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(p.idp.errors).toEqual([]);
    expect(p.idp.requests).toHaveLength(3);
    expect(() => consumeNativeOidcProof(proof)).toThrow(/consumed/);
    expect(() => saveSession(identity)).toThrow(
      "Native identity evidence must remain in its verified browser session",
    );
    expect(readFederationSessionJson()).toBeNull();
  },
);
it("wrong configured client secret fails at the actual TLS token endpoint without evidence or local admission", async () => {
  const p = await protocol();
  const attempt = await prepareConfiguredOidc(
    { ...p.idp.config, clientSecret: "wrong synthetic secret" },
    callback,
    p.transport,
    p.idp.owner,
  );
  p.idp.authorize(attempt.authorizationUrl);
  await expect(
    attempt.complete({
      state: attempt.state,
      code: "independent-once",
      error: false,
    }),
  ).rejects.toThrow();
  expect(p.idp.requests.map((entry) => entry.path)).toEqual([
    "/issuer/.well-known/openid-configuration",
    "/issuer/token",
  ]);
  expect(p.idp.errors).toHaveLength(1);
  expect(readNativeFederationSession()).toBeNull();
  expect(vaultStore.getSnapshot().status).toBe("empty");
});
it("owner withdrawal after actual TLS token headers cancels the real body before parsing or JWKS/admission", async () => {
  const p = await protocol();
  const stop = new AbortController();
  let parsed = () => -1;
  let cancelled = () => -1;
  const transport = {
    ...p.transport,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await p.transport.fetch(input, init);
      if (String(input).endsWith("/token")) {
        const json = vi.spyOn(response, "json");
        const cancel = response.body && vi.spyOn(response.body, "cancel");
        stop.abort();
        parsed = () => json.mock.calls.length;
        cancelled = () => (cancel ? cancel.mock.calls.length : 0);
      }
      return response;
    },
  };
  const owner = {
    signal: stop.signal,
    assertCurrent: () => stop.signal.throwIfAborted(),
  };
  const attempt = await prepareConfiguredOidc(
    p.idp.config,
    callback,
    transport,
    owner,
  );
  p.idp.authorize(attempt.authorizationUrl);
  await expect(
    attempt.complete({
      state: attempt.state,
      code: "independent-once",
      error: false,
    }),
  ).rejects.toThrow();
  expect(parsed()).toBe(0);
  expect(cancelled()).toBe(1);
  expect(p.idp.requests).toHaveLength(2);
  expect(readNativeFederationSession()).toBeNull();
});
it.each(["drain", "owner", "replacement", "expiry", "target"])(
  "refuses %s during held retirement and cannot publish or borrow a replacement callback",
  async (reason) => {
    const p = await protocol();
    const proof = await p.complete();
    const retired = hold();
    const retire = vi.fn(() => retired.promise);
    let live = true;
    const selected = {
      ...target,
      assertSessionCurrent() {
        if (!live) throw new Error("original owner withdrew");
      },
      retireProtocol: retire,
    };
    const pending = runtime().admit(proof, selected);
    const refused = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
    expect(readNativeFederationSession()).toBeNull();
    expect(() => consumeNativeOidcProof(proof)).toThrow(/consumed/);
    if (reason === "owner") live = false;
    if (reason === "replacement") runtime();
    if (reason === "expiry")
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 180000);
    if (reason === "target") selected.assertSessionCurrent = () => undefined;
    if (reason === "drain") retired.reject(new Error("original drain failed"));
    else retired.resolve();
    await refused;
    expect(readNativeFederationSession()).toBeNull();
    expect(vaultStore.getSnapshot().status).toBe("empty");
  },
);
it("real local PIN/password ceremony keeps locked ciphertext and identity while an original Networking lease cannot revive", async () => {
  const c = await localCeremony();
  expect(() => localVaultSessionGuard(vaultStore)).toThrow(/Unlock/);
  const identity = await c.runtime.admit(c.proof, c.target);
  expect(loadSession()).toBe(identity);
  expect(vaultStore.getSnapshot().status).toBe("locked");
  await expect(vaultStore.unlockWithPin("82946732")).rejects.toThrow();
  expect(loadSession()).toBe(identity);
  expect(material()).toBe(c.before);
  expect(kvGet("tomb/personal/body")).toBe(c.body);
  await vaultStore.unlockWithPin("82946731");
  expect(c.network.lease.signal.aborted).toBe(true);
  expect(c.network.assertCurrent).toThrow();
  expect(c.transport.assertCurrent).toThrow();
  expect(loadSession()).toBe(identity);
  expect(material()).toBe(c.before);
  expect(kvGet("tomb/personal/body")).toBe(c.body);
  expect(vaultStore.getSnapshot().folders.map((f) => f.name)).toContain(
    "Original OIDC protected folder",
  );
  const guard = localVaultSessionGuard(vaultStore);
  expect(guard.current().tomb).toBe("personal");
  guard.close();
  expect(
    readStoredSessionSync(JSON.stringify(identity), () => true),
  ).toBeNull();
  await expect(
    restoreAuthenticatedSession(
      JSON.stringify(identity),
      null,
      c.transport.fetch,
    ),
  ).resolves.toEqual({ kind: "rejected", reason: "invalid" });
  await vaultStore.lock();
  expect(loadSession()).toBeNull();
});
it("real ordinary password unlock preserves original vault and clears local identity at the next explicit lock", async () => {
  const c = await localCeremony("password");
  const identity = await c.runtime.admit(c.proof, c.target);
  expect(vaultStore.getSnapshot().status).toBe("locked");
  await expect(vaultStore.unlock("wrong ordinary password")).rejects.toThrow();
  expect(loadSession()).toBe(identity);
  await vaultStore.unlock("ordinary local test password");
  expect(material()).toBe(c.before);
  expect(kvGet("tomb/personal/body")).toBe(c.body);
  expect(loadSession()).toBe(identity);
  expect(c.network.lease.signal.aborted).toBe(true);
  await vaultStore.lock();
  expect(loadSession()).toBeNull();
});
it.each(["resave", "auth", "lock", "unlock"])(
  "real saved owner refuses %s during retirement without changing the encrypted vault",
  async (reason) => {
    const c = await localCeremony();
    const retireProtocol = () =>
      c.retireWith(async () => {
        if (reason === "resave")
          await writeIdentityConnection(c.saved, c.connection.connectionId);
        if (reason === "auth") advanceAuthGeneration();
        if (reason === "lock") await vaultStore.lock();
        if (reason === "unlock") await vaultStore.unlockWithPin("82946731");
      });
    await expect(
      c.runtime.admit(c.proof, { ...c.target, retireProtocol }),
    ).rejects.toThrow();
    expect(loadSession()).toBeNull();
    expect(material()).toBe(c.before);
    expect(kvGet("tomb/personal/body")).toBe(c.body);
    if (reason !== "unlock")
      expect(vaultStore.getSnapshot().status).toBe("locked");
  },
);

it("cold sealed adapter hydration preserves original client credential and requires fresh signed evidence before local identity", async () => {
  const storage = fixture();
  const p = await protocol();
  const { connection } = await saveAdapter(p.idp);
  await kvFlush();
  expect([...storage.files.values()].join("\n")).not.toContain(
    p.idp.config.clientSecret,
  );
  kvForgetAll();
  forgetAtRestKeyForTest();
  await hydrateIdentityConnections();
  await kvHydrate([SETTINGS_PERSIST_KEY]);
  const saved = getIdentityConnectionRuntime(connection.connectionId);
  if (!saved) throw new Error("Original sealed adapter failed to hydrate");
  expect(saved.clientSecret).toBe(p.idp.config.clientSecret);
  expect(loadSession()).toBeNull();
  const attempt = await prepareConfiguredOidc(
    {
      ...p.idp.config,
      issuer: saved.issuer,
      clientId: saved.clientId,
      clientSecret: saved.clientSecret,
    },
    callback,
    p.transport,
    p.idp.owner,
  );
  p.idp.authorize(attempt.authorizationUrl);
  const proof = await attempt.complete({
    state: attempt.state,
    code: "independent-once",
    error: false,
  });
  const current = runtime();
  const identity = await current.admit(proof, {
    ...target,
    connectionId: connection.connectionId,
    assertSessionCurrent(claims) {
      if (
        !configuredIdentitySessionTrusted({
          upstreamId: `identity:${connection.connectionId}`,
          assertionFormat: "native-oidc",
          issuer: claims.issuer,
          audience: claims.audience,
        })
      )
        throw new Error("Original saved target changed");
    },
    retireProtocol: async () => {
      p.stop.abort();
    },
  });
  expect(loadSession()).toBe(identity);
  expect(readFederationSessionJson()).toBeNull();
  current.dispose();
  expect(loadSession()).toBeNull();
  expect(p.idp.errors).toEqual([]);
});
