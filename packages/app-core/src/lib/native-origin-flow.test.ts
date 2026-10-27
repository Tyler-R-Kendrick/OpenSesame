import {
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attestNativeBrowserOAuthRevocation } from "./native-browser-oauth-attestation.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { ORIGIN_TOKEN_BASE } from "./native-origin-configuration.js";
import { readNativeOriginPrivateKey } from "./native-origin-configuration.js";
import {
  ORIGIN_TEST_INSTALLATION,
  originFixture,
} from "./native-origin.test-support.js";
import { vaultCredentialField } from "./vault-credential-custody.js";
import { vaultStore } from "./vault/store.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup() {
  const fixture = await originFixture();
  closes.push(fixture.close);
  return fixture;
}
type OriginFixture = Awaited<ReturnType<typeof setup>>;
async function connected(fixture: OriginFixture) {
  const saved = await fixture.driver.configure(fixture.input);
  await fixture.driver.authorize?.(saved.connectionId);
  return saved;
}
type SavedConnection = Awaited<ReturnType<typeof connected>>;

function expectInstallation(f: OriginFixture): void {
  expect(f.state.installUrls).toHaveLength(1);
  const install = f.state.installUrls[0];
  expect(install?.origin + install?.pathname).toBe(
    "https://cursor.com/codebase/apps/install",
  );
  expect(install?.searchParams.get("client_id")).toBe("app_01synthetic");
  expect(install?.searchParams.get("scope")).toBe("repository:contents:read");
  expect(install?.searchParams.get("redirect_uri")).toBe(f.owner.redirectUri);
  expect(install?.searchParams.get("state")).toHaveLength(43);
  expect(install?.searchParams.has("response_type")).toBe(false);
  expect(install?.searchParams.has("code_challenge")).toBe(false);
  expect(install?.searchParams.has("code_challenge_method")).toBe(false);
}

function expectConnectedInstallation(
  f: OriginFixture,
  saved: SavedConnection,
): void {
  const pendingless = loadNativeConnectorRecord(saved.connectionId);
  expect(pendingless?.privateState.pending).toEqual({});
  expect(f.state.calls.map((call) => call.url)).toEqual([
    "https://api.cursor.com/v1/origin/.well-known/openid-configuration",
    "https://api.cursor.com/v1/origin/keys",
    `${ORIGIN_TOKEN_BASE}/${ORIGIN_TEST_INSTALLATION}/access_tokens`,
    "https://api.cursor.com/v1/origin/rate_limit",
  ]);
  const mint = f.state.calls[2];
  expect(mint?.method).toBe("POST");
  expect(JSON.parse(mint?.body ?? "{}")).toEqual({
    scopes: ["repository:contents:read"],
  });
  const appJwt = f.state.appJwts[0] ?? "";
  expect(decodeProtectedHeader(appJwt)).toEqual({
    alg: "EdDSA",
    kid: "app_01synthetic",
    typ: "JWT",
  });
  const appClaims = decodeJwt(appJwt);
  expect(appClaims).toEqual({
    iss: "app_01synthetic",
    aud: "origin-apps",
    iat: expect.any(Number),
    exp: expect.any(Number),
  });
  expect((appClaims.exp ?? 0) - (appClaims.iat ?? 0)).toBe(300);
  const grant = pendingless?.privateState.grants.user;
  expect(grant).toMatchObject({
    targetId: ORIGIN_TEST_INSTALLATION,
    accessToken: "oit_synthetic_1",
    scopes: ["repository:contents:read"],
  });
  expect(grant?.refreshToken).toBeUndefined();
  expect(readNativeConnector(saved.connectionId)).toMatchObject({
    status: "connected",
    identity: { id: ORIGIN_TEST_INSTALLATION },
  });
}

describe("Cursor Origin installation", () => {
  it("installs without OAuth code or PKCE, mints with an exact app JWT, and verifies rate limit", async () => {
    const f = await setup();
    const saved = await connected(f);
    expectInstallation(f);
    expectConnectedInstallation(f, saved);
  });

  it.each([
    ["audience", { receiptClaims: { aud: "app_other" } }],
    ["issuer", { receiptClaims: { iss: "https://attacker.invalid" } }],
    ["type", { receiptHeader: { typ: "JWT" } }],
    ["state", { receiptClaims: { state: "forged-state" } }],
    ["key id", { receiptHeader: { kid: "retired-or-unknown" } }],
    ["namespace", { receiptClaims: { namespace_id: null } }],
  ])("rejects a receipt with the wrong %s", async (_name, override) => {
    const f = await setup();
    Object.assign(f.state, override);
    const saved = await f.driver.configure(f.input);
    await expect(f.driver.authorize?.(saved.connectionId)).rejects.toThrow();
    expect(readNativeConnector(saved.connectionId)?.status).toBe(
      "configuration",
    );
    expect(f.state.appJwts).toEqual([]);
  });

  it("rejects an expired installation receipt before minting", async () => {
    const f = await setup();
    const now = Math.floor(Date.now() / 1000);
    f.state.receiptClaims = { iat: now - 600, exp: now - 300 };
    const saved = await f.driver.configure(f.input);
    await expect(f.driver.authorize?.(saved.connectionId)).rejects.toThrow();
    expect(f.state.appJwts).toEqual([]);
  });

  it("remints an expired installation token without another installation", async () => {
    const f = await setup();
    f.state.tokenLifetime = 1_000;
    const saved = await connected(f);
    vi.setSystemTime(Date.now() + 2_000);
    await f.driver.verify(saved.connectionId);
    expect(f.state.minted).toBe(2);
    expect(f.state.installUrls).toHaveLength(1);
    expect(
      loadNativeConnectorRecord(saved.connectionId)?.privateState.grants.user
        ?.accessToken,
    ).toBe("oit_synthetic_2");
    expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  });

  it("keeps repeated near-expiry remints active without revocation cleanup", async () => {
    const f = await setup();
    f.state.tokenLifetime = 10_000;
    const saved = await connected(f);
    await f.driver.verify(saved.connectionId);
    const caller = new AbortController();
    await f.driver.invoke(
      saved.connectionId,
      "provider.read",
      {},
      caller.signal,
    );
    expect(f.state.minted).toBe(3);
    expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
    expect(
      loadNativeConnectorRecord(saved.connectionId)?.privateState.recovery,
    ).toEqual([]);
  });

  it("requires explicit reauthorization when the installation is removed", async () => {
    const f = await setup();
    const saved = await connected(f);
    f.state.removed = true;
    await expect(f.driver.verify(saved.connectionId)).rejects.toMatchObject({
      code: "expired",
    });
    expect(readNativeConnector(saved.connectionId)).toMatchObject({
      status: "reauthorize",
      grants: [{ needsReauth: true }],
    });
    const calls = f.state.calls.length;
    await expect(f.driver.verify(saved.connectionId)).rejects.toMatchObject({
      code: "expired",
    });
    expect(f.state.calls).toHaveLength(calls);
  });

  it("reinstalls after removal without token-revocation cleanup", async () => {
    const f = await setup();
    const saved = await connected(f);
    f.state.removed = true;
    await expect(f.driver.verify(saved.connectionId)).rejects.toMatchObject({
      code: "expired",
    });
    f.state.removed = false;
    f.state.installationId = "i_02replacement";
    await f.driver.authorize?.(saved.connectionId);
    expect(f.state.installUrls).toHaveLength(2);
    expect(readNativeConnector(saved.connectionId)).toMatchObject({
      status: "connected",
      identity: { id: "i_02replacement" },
      targets: [{ id: "i_02replacement" }],
    });
    expect(
      loadNativeConnectorRecord(saved.connectionId)?.privateState.grants.user
        ?.targetId,
    ).toBe("i_02replacement");
    expect(
      loadNativeConnectorRecord(saved.connectionId)?.privateState.recovery,
    ).toEqual([]);
  });

  it("refuses an invalid rate-limit resource without activating the grant", async () => {
    const f = await setup();
    f.state.rateResponse = {
      resources: {
        core: { limit: 6000, remaining: "5999", reset: 1, used: 0 },
      },
    };
    const saved = await f.driver.configure(f.input);
    await expect(f.driver.authorize?.(saved.connectionId)).rejects.toThrow();
    expect(readNativeConnector(saved.connectionId)?.status).toBe("cleanup");
    expect(readNativeConnector(saved.connectionId)?.verifiedAt).toBeNull();
  });

  it("attests and removes a failed installation with its own credential classification", async () => {
    const f = await setup();
    f.state.rateResponse = {
      resources: {
        core: { limit: "invalid", remaining: 0, reset: 0, used: 0 },
      },
    };
    const saved = await f.driver.configure(f.input);
    await expect(f.driver.authorize?.(saved.connectionId)).rejects.toThrow();
    const recovery = loadNativeConnectorRecord(saved.connectionId)?.privateState
      .recovery[0];
    if (!recovery) throw new Error("Expected a failed installation obligation");
    await attestNativeBrowserOAuthRevocation(saved.connectionId, recovery.id);
    expect(readNativeConnector(saved.connectionId)?.recovery).toEqual([]);
    const release = registerNativeProviderCleanup("origin", {
      ...f.driver.cleanup,
      capture: () => f.owner.transport,
    });
    try {
      await removeNativeConnectorWithCleanup(saved.connectionId);
    } finally {
      release();
    }
    expect(readNativeConnector(saved.connectionId)).toBeNull();
    expect(
      vaultStore
        .getSnapshot()
        .items.some(
          (item) =>
            item.kind === "credential" &&
            vaultCredentialField(item) === "appPrivateKey",
        ),
    ).toBe(false);
  });

  it("keeps the private key sealed and forgets it with the connection", async () => {
    const f = await setup();
    const saved = await connected(f);
    expect(readNativeOriginPrivateKey(saved.connectionId, f.owner)).toBe(
      f.privateKey,
    );
    expect(
      JSON.stringify(loadNativeConnectorRecord(saved.connectionId)),
    ).not.toContain(f.privateKey);
    const release = registerNativeProviderCleanup("origin", {
      ...f.driver.cleanup,
      capture: () => f.owner.transport,
    });
    try {
      await removeNativeConnectorWithCleanup(saved.connectionId);
    } finally {
      release();
    }
    expect(readNativeConnector(saved.connectionId)).toBeNull();
    expect(
      vaultStore
        .getSnapshot()
        .items.some(
          (item) =>
            item.kind === "credential" &&
            vaultCredentialField(item) === "appPrivateKey",
        ),
    ).toBe(false);
  });

  it("retires a replaced key through cleanup without deleting its replacement", async () => {
    const f = await setup();
    const first = await f.driver.configure(f.input);
    const replacement = await generateKeyPair("Ed25519", {
      extractable: true,
    });
    const privateKey = await exportPKCS8(replacement.privateKey);
    const saved = await f.driver.configure({
      ...f.input,
      connectionId: first.connectionId,
      revision: first.revision,
      credentials: { private_key: privateKey },
    });
    const record = loadNativeConnectorRecord(saved.connectionId);
    expect(record?.privateState.recovery).toHaveLength(1);
    expect(record?.privateState.recovery[0]?.credentials).toMatchObject({
      phase: "superseded",
      origin_app_binding: first.configuration.fingerprint,
    });
    expect(readNativeOriginPrivateKey(saved.connectionId, f.owner)).toBe(
      privateKey,
    );
    const release = registerNativeProviderCleanup("origin", f.driver.cleanup);
    try {
      await retryNativeConnectorCleanup(saved.connectionId, f.owner.transport);
    } finally {
      release();
    }
    expect(readNativeConnector(saved.connectionId)?.status).toBe(
      "configuration",
    );
    expect(readNativeOriginPrivateKey(saved.connectionId, f.owner)).toBe(
      privateKey,
    );
    const keys = vaultStore
      .getSnapshot()
      .items.filter(
        (item) =>
          item.kind === "credential" &&
          vaultCredentialField(item) === "appPrivateKey",
      );
    expect(keys).toHaveLength(1);
    expect(keys[0]?.deletedAt).toBeNull();
    expect(
      keys[0]?.kind === "credential" && keys[0].method.type === "token"
        ? keys[0].method.token
        : null,
    ).toBe(privateKey);
  });

  it("removes both keys when removal starts with superseded cleanup pending", async () => {
    const f = await setup();
    const first = await f.driver.configure(f.input);
    const replacement = await generateKeyPair("Ed25519", {
      extractable: true,
    });
    const saved = await f.driver.configure({
      ...f.input,
      connectionId: first.connectionId,
      revision: first.revision,
      credentials: { private_key: await exportPKCS8(replacement.privateKey) },
    });
    const release = registerNativeProviderCleanup("origin", f.driver.cleanup);
    try {
      await removeNativeConnectorWithCleanup(saved.connectionId);
    } finally {
      release();
    }
    expect(readNativeConnector(saved.connectionId)).toBeNull();
    expect(
      vaultStore
        .getSnapshot()
        .items.filter(
          (item) =>
            item.kind === "credential" &&
            vaultCredentialField(item) === "appPrivateKey",
        ),
    ).toEqual([]);
  });

  it("rejects a non-Ed25519 app key before saving", async () => {
    const f = await setup();
    const rsa = await generateKeyPair("RS256", { extractable: true });
    await expect(
      f.driver.configure({
        ...f.input,
        credentials: { private_key: await exportPKCS8(rsa.privateKey) },
      }),
    ).rejects.toThrow();
    expect(f.state.calls).toEqual([]);
  });
});
