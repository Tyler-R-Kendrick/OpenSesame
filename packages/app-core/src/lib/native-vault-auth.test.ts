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
} from "./native-connector-store.js";
import { completeNativeVaultOidc } from "./native-vault-auth.js";
import { readNativeVaultInstance } from "./native-vault-operations.js";
import {
  authorizeNativeVault,
  cancelNativeVaultOidc,
  configureNativeVault,
} from "./native-vault-session.js";

import {
  authorizationUrl,
  backend,
  disposers,
  input,
  nonce,
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

it.each(["vault", "openbao"] as const)(
  "%s signs in, reads permitted KV, restores sealed access and revokes the issued session",
  async (providerId) => {
    const reload = backend();
    const { fetcher } = provider(providerId);
    const id = await configureNativeVault({ ...input, providerId });
    const authorization = await authorizeNativeVault(id, redirectUri);
    expect(readNativeConnector(id)?.status).toBe("authorizing");
    const init = fetcher.mock.calls[0]?.[1];
    const posted = JSON.parse(String(init?.body));
    expect(posted).toMatchObject({
      role: "browser-read",
      redirect_uri: redirectUri,
    });
    expect(posted.client_nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(new Headers(init?.headers).get("X-Vault-Namespace")).toBe(
      "engineering",
    );
    const connected = await completeNativeVaultOidc(id, {
      state: authorization.state,
      code: "code-from-approved-idp",
    });
    expect(connected.status).toBe("connected");
    expect(connected.identity?.id).toBe("entity-from-idp");
    const callback = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(callback.searchParams.get("client_nonce")).toBe(posted.client_nonce);
    expect(callback.searchParams.get("nonce")).toBe(nonce);
    expect(callback.searchParams.get("state")).toBe(state);
    expect(JSON.stringify(readDeviceRows())).not.toContain(token);
    expect(JSON.stringify(readDeviceRows())).not.toContain(nonce);
    expect(JSON.stringify(connected)).not.toContain(token);
    reload();
    expect(readNativeConnector(id)?.status).toBe("connected");
    expect(
      await readNativeVaultInstance(id, {
        mount: "secret",
        path: "app/config",
      }),
    ).toEqual({
      data: { setting: "real-KV-shaped-value" },
      metadata: { version: 2 },
    });
    expect(await removeNativeConnectorWithCleanup(id)).toBe(true);
    const revocation = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/revoke-self"),
    );
    expect(new Headers(revocation?.[1]?.headers).get("X-Vault-Token")).toBe(
      token,
    );
    expect(new Headers(revocation?.[1]?.headers).get("X-Vault-Namespace")).toBe(
      "engineering",
    );
    expect(readNativeConnector(id)).toBeNull();
  },
);

it("rejects another connection's callback and consumes the accepted state exactly once", async () => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  await expect(
    completeNativeVaultOidc(id, {
      state: "other-state-012345678901234567890123",
      code: "code",
    }),
  ).rejects.toThrow("another browser");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await completeNativeVaultOidc(id, { state, code: "code" });
  const calls = fetcher.mock.calls.length;
  await expect(
    completeNativeVaultOidc(id, { state, code: "code" }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(calls);
});

it("clears cancelled state without minting a provider token", async () => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  await cancelNativeVaultOidc(id);
  await expect(
    completeNativeVaultOidc(id, { state, code: "code" }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    loadNativeConnectorRecord(id)?.privateState.credentials.oidc_nonce,
  ).toBeUndefined();
});

it("expires a pending state before any token exchange", async () => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
  await expect(
    completeNativeVaultOidc(id, { state, code: "code" }),
  ).rejects.toThrow("expired");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("retains an issued token for cleanup if capability disposal happens during the mint reply", async () => {
  backend();
  const runtime = provider();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  runtime.fetcher.mockImplementationOnce(async () => {
    runtime.dispose();
    return Response.json({
      auth: { client_token: token, lease_duration: 300 },
    });
  });
  await expect(
    completeNativeVaultOidc(id, { state, code: "code" }, runtime.transport),
  ).rejects.toThrow("disposed");
  const record = loadNativeConnectorRecord(id);
  expect(record?.privateState.recovery[0]?.grant?.accessToken).toBe(token);
  expect(readNativeConnector(id)?.status).toBe("cleanup");
  expect(JSON.stringify(readDeviceRows())).not.toContain(token);
});
it("keeps the issued grant recoverable when cancellation occurs while its final activation write is staged", async () => {
  const reload = backend();
  const runtime = provider();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  runtime.fetcher.mockResolvedValueOnce(
    Response.json({ auth: { client_token: token, lease_duration: 300 } }),
  );
  runtime.fetcher.mockImplementationOnce(async () => {
    vi.mocked(kv.kvSeams.kvSetDurable).mockImplementationOnce(
      async (_key, _value, beforeCommit) => {
        expect(beforeCommit).toBeTypeOf("function");
        await Promise.resolve();
        runtime.dispose();
        beforeCommit?.();
      },
    );
    return Response.json({
      data: {
        entity_id: "entity-from-idp",
        display_name: "oidc-engineer",
        policies: ["browser-read"],
        ttl: 300,
        renewable: true,
      },
    });
  });
  await expect(
    completeNativeVaultOidc(id, { state, code: "issued-provider-code" }),
  ).rejects.toThrow("disposed");
  reload();
  expect(readNativeConnector(id)?.status).toBe("cleanup");
  expect(loadNativeConnectorRecord(id)?.privateState.grants).toEqual({});
  expect(
    loadNativeConnectorRecord(id)?.privateState.recovery[0]?.grant?.accessToken,
  ).toBe(token);
});

it("revokes a minted token that fails lookup-self without reporting connected", async () => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  fetcher.mockResolvedValueOnce(
    Response.json({ auth: { client_token: token, lease_duration: 300 } }),
  );
  fetcher.mockResolvedValueOnce(
    Response.json({ errors: ["permission denied"] }, { status: 403 }),
  );
  await expect(
    completeNativeVaultOidc(id, { state, code: "code" }),
  ).rejects.toThrow("permissions");
  expect(readNativeConnector(id)?.status).toBe("configuration");
  expect(loadNativeConnectorRecord(id)?.privateState.recovery).toEqual([]);
  expect(
    fetcher.mock.calls.some(([url]) => String(url).endsWith("/revoke-self")),
  ).toBe(true);
  await removeNativeConnectorWithCleanup(id);
});

it.each([
  "http://identity.example.org/authorize",
  "https://identity.example.org/authorize?state=duplicate&",
  "https://identity.example.org/authorize?response_mode=form_post&",
])("refuses an unsafe or incompatible authorization URL %s", async (prefix) => {
  backend();
  const { fetcher } = provider();
  const id = await configureNativeVault(input);
  const source = new URL(authorizationUrl());
  const unsafe = prefix.includes("?")
    ? `${prefix}${source.search.slice(1)}`
    : `${prefix}${source.search}`;
  fetcher.mockResolvedValueOnce(Response.json({ data: { auth_url: unsafe } }));
  await expect(authorizeNativeVault(id, redirectUri)).rejects.toThrow(
    "browser OIDC",
  );
  expect(loadNativeConnectorRecord(id)?.privateState.pending).toEqual({});
});

it("rejects unsafe instance, mount, namespace and KV paths before provider egress", async () => {
  backend();
  const { fetcher } = provider();
  for (const changed of [
    { endpoint: "http://vault.example.org" },
    { authMount: "../token" },
    { namespace: "x\r\nX-Injected: yes" },
    { role: "role?unsafe" },
  ])
    await expect(
      configureNativeVault({ ...input, ...changed }),
    ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  const id = await configureNativeVault(input);
  await authorizeNativeVault(id, redirectUri);
  await completeNativeVaultOidc(id, { state, code: "code" });
  const calls = fetcher.mock.calls.length;
  await expect(
    readNativeVaultInstance(id, { mount: "secret", path: "../sys/config" }),
  ).rejects.toThrow("traversal");
  expect(fetcher).toHaveBeenCalledTimes(calls);
});
