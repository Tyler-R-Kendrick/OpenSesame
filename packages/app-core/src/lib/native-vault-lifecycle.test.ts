import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { readDeviceRows } from "./device-connector-records.js";
import * as kv from "./kv.js";
import { removeNativeConnectorWithCleanup } from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { completeNativeVaultOidc } from "./native-vault-auth.js";
import {
  checkNativeVaultAccess,
  readNativeVaultInstance,
  verifyNativeVault,
} from "./native-vault-operations.js";
import {
  authorizeNativeVault,
  cancelNativeVaultOidc,
  configureNativeVault,
  nativeVaultClassification,
} from "./native-vault-session.js";
import {
  backend,
  disposers,
  input,
  provider,
  redirectUri,
  state,
  token,
} from "./native-vault.test-support.js";

beforeEach(kv.kvForgetAll);
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  configureHost(createTestHost());
  forgetAtRestKeyForTest();
});
async function signedIn() {
  backend();
  const runtime = provider();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  const view = await completeNativeVaultOidc(id, { state, code: "code" });
  return { ...runtime, id, view };
}
it("keeps a valid session connected when provider ACL denies one KV path", async () => {
  const { id, fetcher } = await signedIn();
  fetcher.mockResolvedValueOnce(
    Response.json({ errors: ["permission denied"] }, { status: 403 }),
  );
  await expect(
    readNativeVaultInstance(id, { mount: "secret", path: "app/config" }),
  ).rejects.toThrow("permissions");
  expect(readNativeConnector(id)?.status).toBe("connected");
  expect(
    loadNativeConnectorRecord(id)?.privateState.grants.user?.accessToken,
  ).toBe(token);
});
it("blocks KV reads while a new sign-in or cleanup is pending", async () => {
  const { id, fetcher } = await signedIn();
  await authorizeNativeVault(id, redirectUri);
  const calls = fetcher.mock.calls.length;
  await expect(
    readNativeVaultInstance(id, { mount: "secret", path: "app/config" }),
  ).rejects.toThrow("Sign in");
  expect(fetcher).toHaveBeenCalledTimes(calls);
});
it("refuses KV access without a provider verification proof", async () => {
  const { id, view, fetcher } = await signedIn();
  await updateNativeConnector(id, view, nativeVaultClassification, (record) => {
    record.privateState.verification = null;
    record.runtime.verifiedAt = null;
    return record;
  });
  const calls = fetcher.mock.calls.length;
  await expect(
    readNativeVaultInstance(id, { mount: "secret", path: "app/config" }),
  ).rejects.toThrow("Sign in");
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect((await verifyNativeVault(id)).status).toBe("connected");
});
it("invalidates a revoked session on a resource 401 and requires provider proof to restore it", async () => {
  const { id, fetcher } = await signedIn();
  fetcher.mockResolvedValueOnce(
    Response.json({ errors: ["invalid token"] }, { status: 401 }),
  );
  await expect(
    readNativeVaultInstance(id, { mount: "secret", path: "app/config" }),
  ).rejects.toThrow("authorization");
  expect(readNativeConnector(id)?.status).toBe("reauthorize");
  expect((await verifyNativeVault(id)).status).toBe("connected");
});
it("does not invalidate a newer connection when an older resource read is denied", async () => {
  const { id, fetcher } = await signedIn();
  fetcher.mockImplementationOnce(async () => {
    const current = loadNativeConnectorRecord(id);
    if (!current) throw new Error("Missing connection");
    await updateNativeConnector(
      id,
      {
        revision: current.revision,
        fingerprint: current.configuration.fingerprint,
      },
      nativeVaultClassification,
      (record) => {
        record.configuration.displayName = "Concurrent edit";
        return record;
      },
    );
    return Response.json({ errors: ["invalid old token"] }, { status: 401 });
  });
  await expect(
    readNativeVaultInstance(id, { mount: "secret", path: "app/config" }),
  ).rejects.toThrow("Connector changed");
  expect(readNativeConnector(id)?.status).toBe("connected");
});
it.each([401, 403])(
  "finishes journaled revocation after a %s revoke response and a definitive lookup 401",
  async (status) => {
    const { id, fetcher } = await signedIn();
    fetcher.mockResolvedValueOnce(
      Response.json({ errors: ["invalid token"] }, { status }),
    );
    fetcher.mockResolvedValueOnce(
      Response.json({ errors: ["invalid token"] }, { status: 401 }),
    );
    expect(await removeNativeConnectorWithCleanup(id)).toBe(true);
    expect(readNativeConnector(id)).toBeNull();
  },
);
it("retains the revoke obligation when provider ACL denies both revoke-self and lookup-self", async () => {
  const { id, fetcher } = await signedIn();
  for (let attempt = 0; attempt < 2; attempt++)
    fetcher.mockResolvedValueOnce(
      Response.json({ errors: ["permission denied"] }, { status: 403 }),
    );
  await expect(removeNativeConnectorWithCleanup(id)).rejects.toThrow(
    "cleanup failed",
  );
  expect(readNativeConnector(id)?.status).toBe("cleanup");
  expect(
    loadNativeConnectorRecord(id)?.privateState.recovery[0]?.grant?.accessToken,
  ).toBe(token);
  expect(readDeviceRows().some((row) => row.connectionId === id)).toBe(true);
  expect(await removeNativeConnectorWithCleanup(id)).toBe(true);
  expect(readNativeConnector(id)).toBeNull();
});
it("does not forget an issued token when revocation is denied but the session remains usable", async () => {
  const { id, fetcher } = await signedIn();
  fetcher.mockResolvedValueOnce(
    Response.json({ errors: ["permission denied"] }, { status: 403 }),
  );
  await expect(removeNativeConnectorWithCleanup(id)).rejects.toThrow(
    "cleanup failed",
  );
  expect(readNativeConnector(id)?.status).toBe("cleanup");
  expect(
    loadNativeConnectorRecord(id)?.privateState.recovery[0]?.grant?.accessToken,
  ).toBe(token);
});

it("records an unobserved exchange honestly and lets the user sign in again without a fictional revoked token", async () => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  fetcher.mockRejectedValueOnce(new Error("Dropped callback response"));
  await expect(
    completeNativeVaultOidc(id, { state, code: "private-authorization-code" }),
  ).rejects.toThrow("reach");
  const after = readNativeConnector(id);
  expect(after?.status).toBe("configuration");
  expect(after?.configuration.parameters.authorization_outcome).toBe(
    "exchange-unobserved",
  );
  expect(loadNativeConnectorRecord(id)?.privateState.grants).toEqual({});
  expect(loadNativeConnectorRecord(id)?.privateState.recovery).toEqual([]);
  expect(
    fetcher.mock.calls.some(([url]) => String(url).endsWith("/revoke-self")),
  ).toBe(false);
  expect(JSON.stringify(readDeviceRows())).not.toContain(
    "private-authorization-code",
  );
  expect(await configureNativeVault({ ...input, connectionId: id })).toBe(id);
  await authorizeNativeVault(id, redirectUri);
  expect(
    (await completeNativeVaultOidc(id, { state, code: "new-code" })).status,
  ).toBe("connected");
  expect(
    readNativeConnector(id)?.configuration.parameters.authorization_outcome,
  ).toBeUndefined();
});

it("clears a definitely denied exchange and permits a fresh approved sign-in", async () => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  fetcher.mockResolvedValueOnce(
    Response.json({ errors: ["denied"] }, { status: 400 }),
  );
  await expect(
    completeNativeVaultOidc(id, { state, code: "denied-code" }),
  ).rejects.toThrow("authorization");
  expect(
    readNativeConnector(id)?.configuration.parameters.authorization_outcome,
  ).toBe("denied");
  expect(loadNativeConnectorRecord(id)?.privateState.recovery).toEqual([]);
  await authorizeNativeVault(id, redirectUri);
  expect(
    (await completeNativeVaultOidc(id, { state, code: "new-code" })).status,
  ).toBe("connected");
});

it("replaces an authorized session only after verifying the new token and revoking the old one", async () => {
  const { id, fetcher } = await signedIn();
  await authorizeNativeVault(id, redirectUri);
  const rotated = "hvs.new-approved-session-token";
  fetcher.mockResolvedValueOnce(
    Response.json({ auth: { client_token: rotated, lease_duration: 300 } }),
  );
  expect(
    (await completeNativeVaultOidc(id, { state, code: "new-code" })).status,
  ).toBe("connected");
  const revoke = fetcher.mock.calls.find(([url]) =>
    String(url).endsWith("/revoke-self"),
  );
  expect(new Headers(revoke?.[1]?.headers).get("X-Vault-Token")).toBe(token);
  expect(
    loadNativeConnectorRecord(id)?.privateState.grants.user?.accessToken,
  ).toBe(rotated);
});

it("does not let an older cancelled popup clear a newer sign-in on the same connection", async () => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  const previous = await authorizeNativeVault(id, redirectUri);
  await cancelNativeVaultOidc(id, previous.state);
  const nextState = "new-provider-state-012345678901234567890123";
  const url = new URL("https://identity.example.org/authorize");
  url.search = new URLSearchParams({
    client_id: "vault",
    state: nextState,
    nonce: "new-nonce",
    redirect_uri: redirectUri,
    response_type: "code",
  }).toString();
  fetcher.mockResolvedValueOnce(
    Response.json({ data: { auth_url: url.href } }),
  );
  await authorizeNativeVault(id, redirectUri);
  const before = readNativeConnector(id);
  await cancelNativeVaultOidc(id, previous.state);
  expect(readNativeConnector(id)).toEqual(before);
  expect(loadNativeConnectorRecord(id)?.privateState.pending.user?.state).toBe(
    nextState,
  );
});

it("checks real provider access without changing the UI saved revision or blocking the next operation", async () => {
  const { id, view, fetcher } = await signedIn();
  const before = fetcher.mock.calls.length;
  expect((await checkNativeVaultAccess(id)).policies).toEqual(["browser-read"]);
  expect(fetcher.mock.calls.length).toBe(before + 1);
  expect(readNativeConnector(id)?.revision).toBe(view.revision);
  expect(
    (await readNativeVaultInstance(id, { mount: "secret", path: "app/config" }))
      .metadata.version,
  ).toBe(2);
});

it("accepts the actual Vault 1.21.4 opaque state length while keeping the client nonce sealed and single-use", async () => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  const providerState = "S".repeat(23);
  const nonce = "N".repeat(22);
  const url = new URL("https://identity.example.org/authorize");
  url.search = new URLSearchParams({
    client_id: "vault",
    state: providerState,
    nonce,
    redirect_uri: redirectUri,
    response_type: "code",
  }).toString();
  fetcher.mockResolvedValueOnce(
    Response.json({ data: { auth_url: url.href } }),
  );
  expect((await authorizeNativeVault(id, redirectUri)).state).toBe(
    providerState,
  );
  expect(
    loadNativeConnectorRecord(id)?.privateState.pending.user?.verifier,
  ).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await completeNativeVaultOidc(id, {
        state: providerState,
        code: "approved-code",
      })
    ).status,
  ).toBe("connected");
  const sent = new URL(String(fetcher.mock.calls[1]?.[0]));
  expect(sent.searchParams.get("nonce")).toBe(nonce);
  expect(sent.searchParams.get("state")).toBe(providerState);
  const before = fetcher.mock.calls.length;
  await expect(
    completeNativeVaultOidc(id, {
      state: providerState,
      code: "replayed-code",
    }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(before);
});

it("refuses undersized opaque Vault state before retaining or opening authorization", async () => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  const url = new URL("https://identity.example.org/authorize");
  url.search = new URLSearchParams({
    client_id: "vault",
    state: "short-state",
    nonce: "provider-nonce",
    redirect_uri: redirectUri,
    response_type: "code",
  }).toString();
  fetcher.mockResolvedValueOnce(
    Response.json({ data: { auth_url: url.href } }),
  );
  await expect(authorizeNativeVault(id, redirectUri)).rejects.toThrow(
    "browser OIDC",
  );
  expect(loadNativeConnectorRecord(id)?.privateState.pending).toEqual({});
});
