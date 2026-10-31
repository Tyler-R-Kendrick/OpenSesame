import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { consumeNativeOidcProof } from "../browser/oidc/claims.js";
import { tlsOracle } from "../browser/oidc/tls.test-support.js";
import { prepareConfiguredOidc } from "../browser/oidc/transaction.js";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { configuredIdentitySessionTrusted } from "./federation-configured-token.js";
import {
  type NativeFederationIdentity,
  bindNativeFederationSession,
  readNativeFederationSession,
} from "./federation-native-session.js";
import {
  isOperatorIdpIssuer,
  operatorUpstream,
} from "./federation-operator.js";
import {
  readStoredSessionSync,
  restoreAuthenticatedSession,
} from "./federation-restoration.js";
import { readFederationSessionJson } from "./federation-session-store.js";
import { loadSession, saveSession } from "./federation.js";
import { kvFlush, kvForgetAll } from "./kv.js";
import { type OperatorIdp, readOperatorIdp } from "./operator-idp-config.js";
import { loadSettings, saveSettings, signInMethods } from "./settings.js";
import { buildSuccessMessage } from "./site-broker.js";

const callback =
  "https://pwa.example.test/OpenSesame/auth/native-connector.html";
const disposers: (() => void)[] = [];
beforeEach(() => {
  configureHost(createTestHost());
  kvForgetAll();
});
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  await kvFlush();
  kvForgetAll();
  vi.restoreAllMocks();
  configureHost(createTestHost());
});

function provider(
  issuer = "https://identity.example.test/issuer",
): OperatorIdp {
  return {
    providerId: "oidc",
    connectionId: "adapter_original",
    protocol: "oidc",
    nativeIdentity: true,
    issuer,
    clientId: "client: café",
    label: "Owned OIDC",
  };
}
function settings(value: OperatorIdp) {
  saveSettings({
    ...loadSettings(),
    signIn: { builtin: false, providers: [value] },
  });
  const saved = signInMethods().providers[0];
  if (!saved) throw new Error("Missing actual saved public provider");
  return saved;
}
function identity(issuer: string): NativeFederationIdentity {
  return Object.freeze({
    assertionFormat: "native-oidc",
    upstreamId: "identity:adapter_original",
    issuer,
    audience: "client: café",
    pairwiseSub: "fixture-only-no-admission",
    expiresAt: Date.now() + 60000,
    idToken: "",
    jwksUri: "",
  });
}
async function verified(method = "client_secret_basic") {
  const idp = await tlsOracle(method, "both");
  const attempt = await prepareConfiguredOidc(
    idp.config,
    callback,
    idp.transport,
    idp.owner,
  );
  idp.authorize(attempt.authorizationUrl);
  const proof = await attempt.complete({
    state: attempt.state,
    code: "independent-once",
    error: false,
  });
  const consumed = consumeNativeOidcProof(proof);
  settings(provider(consumed.claims.issuer));
  let current: NativeFederationIdentity | null = Object.freeze({
    assertionFormat: "native-oidc",
    upstreamId: "identity:adapter_original",
    issuer: consumed.claims.issuer,
    audience: consumed.claims.audience,
    pairwiseSub: consumed.claims.subject,
    expiresAt: consumed.claims.validUntil,
    idToken: "",
    jwksUri: "",
  });
  const clear = () => {
    current = null;
  };
  disposers.push(
    bindNativeFederationSession({
      read() {
        consumed.owner.assertCurrent();
        if (current && !configuredIdentitySessionTrusted(current))
          throw new Error("Saved native target withdrawn");
        return current;
      },
      clear,
    }),
  );
  return { idp, proof, current };
}

it.each(["client_secret_basic", "client_secret_post", "none"])(
  "%s real TLS proof reaches tab-only no-bearer session and cannot persist or pass through",
  async (method) => {
    const { idp, current, proof } = await verified(method);
    expect(readNativeFederationSession()).toBe(current);
    expect(loadSession()).toBe(current);
    expect(current?.pairwiseSub).toBe("owned-person");
    expect(idp.errors).toEqual([]);
    expect(idp.requests.map((request) => request.path)).toEqual([
      "/issuer/.well-known/openid-configuration",
      "/issuer/token",
      "/issuer/jwks",
    ]);
    expect(() => consumeNativeOidcProof(proof)).toThrow(/already consumed/);
    const before = readFederationSessionJson();
    if (!current) throw new Error("Missing verified fixture session");
    expect(() => saveSession(current)).toThrow(/must remain/);
    expect(readFederationSessionJson()).toBe(before);
    expect(() =>
      buildSuccessMessage(
        {
          origin: "http://localhost:5173",
          clientId: "origin:http://localhost:5173",
          state: "test-state",
          scope: "openid",
        },
        current,
      ),
    ).toThrow("upstream_assertion_format_mismatch");
  },
);

it("the original TLS endpoint authority withdraws the session and cannot be revived by reapproval", async () => {
  const { idp } = await verified();
  expect(readNativeFederationSession()).not.toBeNull();
  idp.withdraw(new URL(idp.tokenBase).origin);
  expect(readNativeFederationSession()).toBeNull();
  idp.approve(new URL(idp.tokenBase).origin);
  expect(readNativeFederationSession()).toBeNull();
  expect(idp.requests).toHaveLength(3);
});

it.each(["owner", "transport"])(
  "original %s abort refuses real TLS entry before any request body",
  async (which) => {
    const idp = await tlsOracle("client_secret_basic");
    const stop = new AbortController();
    const owner = {
      signal: stop.signal,
      assertCurrent: () => stop.signal.throwIfAborted(),
    };
    const transport =
      which === "transport" ? { ...idp.transport, ...owner } : idp.transport;
    stop.abort();
    await expect(
      prepareConfiguredOidc(
        idp.config,
        callback,
        transport,
        which === "owner" ? owner : idp.owner,
      ),
    ).rejects.toThrow();
    expect(idp.requests).toHaveLength(0);
  },
);

it.each(["owner", "transport"])(
  "original %s withdrawal after real TLS headers prevents body consumption and credential POST",
  async (which) => {
    const idp = await tlsOracle("client_secret_basic");
    const stop = new AbortController();
    const owner = {
      signal: stop.signal,
      assertCurrent: () => stop.signal.throwIfAborted(),
    };
    const reads: (() => number)[] = [];
    const cancels: (() => number)[] = [];
    const transport = {
      ...idp.transport,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await idp.transport.fetch(input, init);
        const json = vi.spyOn(response, "json");
        const text = vi.spyOn(response, "text");
        reads.push(
          () => json.mock.calls.length,
          () => text.mock.calls.length,
        );
        if (response.body) {
          const cancel = vi.spyOn(response.body, "cancel");
          cancels.push(() => cancel.mock.calls.length);
        }
        stop.abort();
        return response;
      },
    };
    if (which === "transport") Object.assign(transport, owner);
    await expect(
      prepareConfiguredOidc(
        idp.config,
        callback,
        transport,
        which === "owner" ? owner : idp.owner,
      ),
    ).rejects.toThrow();
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read()).toBe(0);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.()).toBe(1);
    expect(idp.requests).toHaveLength(1);
    expect(idp.requests[0]?.body).toBe("");
  },
);

it.each([undefined, "jwt", "native-oidc"])(
  "cold scalar restoration cannot remove or replace native format %s",
  async (format) => {
    const idp = await tlsOracle("client_secret_basic");
    const saved = settings(provider(idp.config.issuer));
    expect(saved.nativeIdentity).toBe(true);
    const forged = JSON.stringify({
      ...identity(idp.config.issuer),
      assertionFormat: format,
      idToken: "unverified-opaque-assertion",
      jwksUri: `${idp.config.issuer}/jwks`,
    });
    expect(readStoredSessionSync(forged, () => true)).toBeNull();
    await expect(
      restoreAuthenticatedSession(
        forged,
        {
          issuer: saved.issuer,
          clientId: saved.clientId,
          jwksUri: `${idp.config.issuer}/jwks`,
        },
        idp.transport.fetch,
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "invalid" });
    expect(idp.requests).toHaveLength(0);
    expect(() => operatorUpstream(saved)).toThrow(/saved native/);
    expect(isOperatorIdpIssuer(saved.issuer)).toBe(false);
  },
);

it.each([false, "true", null])(
  "native marker %s is rejected rather than silently downgraded",
  (nativeIdentity) => {
    expect(readOperatorIdp({ ...provider(), nativeIdentity })).toBeNull();
  },
);
it.each(["better-auth", "supabase", "saml"])(
  "native OIDC marker cannot select protocol %s",
  (protocol) => {
    expect(readOperatorIdp({ ...provider(), protocol })).toBeNull();
  },
);
it.each(["", " foreign ", "x".repeat(129)])(
  "native marker needs an exact saved connection id %s",
  (connectionId) => {
    expect(readOperatorIdp({ ...provider(), connectionId })).toBeNull();
  },
);

it("native trust pins protocol, marker, exact issuer, audience and connection while public OIDC remains compatible", () => {
  const original = provider();
  settings(original);
  const native = identity(original.issuer);
  expect(configuredIdentitySessionTrusted(native)).toBe(true);
  for (const changed of [
    { ...native, issuer: `${native.issuer}/` },
    { ...native, audience: "different-client" },
    { ...native, upstreamId: "identity:different-connection" },
    { ...native, assertionFormat: "jwt" as const },
  ])
    expect(configuredIdentitySessionTrusted(changed)).toBe(false);
  const { nativeIdentity: marker, ...publicProvider } = original;
  expect(marker).toBe(true);
  settings(publicProvider);
  expect(configuredIdentitySessionTrusted(native)).toBe(false);
  expect(
    configuredIdentitySessionTrusted({
      ...native,
      assertionFormat: "jwt",
      issuer: `${native.issuer}/`,
    }),
  ).toBe(true);
  expect(operatorUpstream(publicProvider).clientId).toBe(original.clientId);
  expect(isOperatorIdpIssuer(original.issuer)).toBe(true);
  expect(
    configuredIdentitySessionTrusted({ ...native, upstreamId: "other" }),
  ).toBe(false);
});

it("signed TLS proof expiry retires only the local native evidence", async () => {
  const { current, idp } = await verified();
  if (!current) throw new Error("Missing verified fixture session");
  const clock = vi.spyOn(Date, "now").mockReturnValue(current.expiresAt + 1);
  try {
    expect(readNativeFederationSession()).toBeNull();
  } finally {
    clock.mockRestore();
  }
  expect(readNativeFederationSession()).toBeNull();
  expect(idp.requests).toHaveLength(3);
});
