import { afterEach, expect, it } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "./device-connector-records.js";
import { kvFlush, kvForgetAll, kvHydrate } from "./kv.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import {
  configureNativeOAuthClient,
  nativeOAuthClientClassification,
} from "./native-oauth-client-config.js";
import {
  CLIENT_SECRET,
  nativeOAuthClientFixture,
} from "./native-oauth-client.test-support.js";
import { createNativeOAuthResourceDriver } from "./native-oauth-resource-driver.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import { localVaultSessionGuard } from "./secret-backends/local-vault-port.js";
import { runtimePassword } from "./secret-backends/runtime.test-support.js";
import { vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";
const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup(
  method: Parameters<typeof nativeOAuthClientFixture>[0] = "client_secret_post",
) {
  const f = await nativeOAuthClientFixture(method);
  closes.push(f.close);
  closes.push(
    bindNativeOAuthBrowserPort({
      redirectUri: f.owner.redirectUri,
      navigate: () => {
        throw new Error("Unexpected navigation");
      },
      scrubCallback: () => {},
      authorize: async (value) => {
        const url = new URL(value);
        f.state.challenge = url.searchParams.get("code_challenge") ?? "";
        return new URLSearchParams({
          native_state: url.searchParams.get("state") ?? "",
          native_code: "one-use-code",
        }).toString();
      },
    }),
  );
  const driver = createNativeOAuthResourceDriver({
    supports: () => true,
    capture: () => {
      const guard = localVaultSessionGuard(vaultStore);
      return {
        ...f.owner,
        transport: {
          ...f.owner.transport,
          assertCurrent: () => {
            f.owner.transport.assertCurrent();
            guard.current();
          },
        },
        close: guard.close,
      };
    },
  });
  const saved = await driver.configure(f.input);
  if (!driver.authorize) throw new Error("Missing actual consent");
  await driver.authorize(saved.connectionId);
  const record = requireNativeOAuthRecord(saved.connectionId);
  const input = {
    ...f.input,
    connectionId: record.connectionId,
    revision: record.revision,
    credentials: { client_secret: "" },
  };
  return { ...f, driver, record, edit: input };
}
it.each(["none", "client_secret_basic", "client_secret_post"] as const)(
  "retains the actually consented %s authority on blank/no-op and metadata edits without another exchange",
  async (method) => {
    const f = await setup(method);
    const items = structuredClone(vaultStore.getSnapshot().items);
    const unchanged = await f.driver.configure(f.edit);
    expect(unchanged.status).toBe("connected");
    expect(unchanged.revision).toBe(f.record.revision);
    expect(requireNativeOAuthRecord(unchanged.connectionId)).toEqual(f.record);
    const changed = await f.driver.configure({
      ...f.edit,
      displayName: "Renamed actual connection",
      icon: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(changed).toMatchObject({
      status: "connected",
      revision: f.record.revision + 1,
      verifiedAt: f.record.runtime.verifiedAt,
    });
    const next = requireNativeOAuthRecord(changed.connectionId);
    expect(next.privateState).toEqual(f.record.privateState);
    expect(next.runtime).toEqual(f.record.runtime);
    expect(next.configuration).toEqual({
      ...f.record.configuration,
      displayName: "Renamed actual connection",
      icon: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(vaultStore.getSnapshot().items).toEqual(items);
    expect(f.requests.map((row) => row.path)).toEqual(["/token", "/resource"]);
  },
);
it("cold-reloads actual encrypted vault and device ledger then reuses the original secret without serializing it into public state", async () => {
  const f = await setup();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlock(runtimePassword);
  const view = readNativeConnector(f.record.connectionId);
  expect(view?.status).toBe("connected");
  const changed = await f.driver.configure({
    ...f.edit,
    revision: view?.revision,
    displayName: "After actual cold reload",
  });
  expect(changed.status).toBe("connected");
  expect(requireNativeOAuthRecord(changed.connectionId).privateState).toEqual(
    f.record.privateState,
  );
  expect(f.requests.map((row) => row.path)).toEqual(["/token", "/resource"]);
  expect(JSON.stringify(readDeviceRows())).not.toContain(CLIENT_SECRET);
  const disk = [...f.local.files.values()].join();
  expect(disk).not.toContain(CLIENT_SECRET);
  expect(disk).not.toContain("issued-access-1");
});
it("requires cleanup before any client, target, protocol, authentication, resource-parameter, scope or key replacement", async () => {
  const f = await setup();
  const changes = [
    ["client_id", "other-client"],
    ["issuer", "https://other.example/issuer"],
    ["authorization_endpoint", "https://other.example/auth"],
    ["token_endpoint", `${f.input.parameters.token_endpoint}/changed`],
    ["resource", `${f.state.resource}/changed`],
    ["resource_protocol", "json"],
    ["resource_parameter", "omit"],
    ["token_auth_method", "none"],
  ] as const;
  for (const [key, value] of changes)
    await expect(
      f.driver.configure({
        ...f.edit,
        parameters: { ...f.edit.parameters, [key]: value },
      }),
    ).rejects.toThrow();
  await expect(
    f.driver.configure({
      ...f.edit,
      parameters: {
        ...f.edit.parameters,
        resource_protocol: "mcp",
        mcp_endpoint: f.state.resource,
        mcp_transport: "streamable-http",
      },
    }),
  ).rejects.toThrow();
  await expect(
    f.driver.configure({
      ...f.edit,
      requestedScopes: { user: ["read:items", "write:items"] },
    }),
  ).rejects.toThrow();
  await expect(
    f.driver.configure({
      ...f.edit,
      credentials: { client_secret: "replacement operator credential" },
    }),
  ).rejects.toThrow();
  expect(requireNativeOAuthRecord(f.record.connectionId)).toEqual(f.record);
  expect(f.requests).toHaveLength(2);
});
it("refuses an edited real Token even before entry and refuses the same edit after an actual reload", async () => {
  const f = await setup();
  const item = vaultStore
    .getSnapshot()
    .items.find((entry) => entry.kind === "credential");
  if (!item || item.kind !== "credential" || item.method.type !== "token")
    throw new Error("Missing actual Token");
  await vaultStore.saveItem({
    ...item,
    method: { ...item.method, token: "changed actual Token" },
  });
  await expect(f.driver.configure(f.edit)).rejects.toThrow();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlock(runtimePassword);
  await expect(f.driver.configure(f.edit)).rejects.toThrow();
  expect(requireNativeOAuthRecord(f.record.connectionId)).toEqual(f.record);
  expect(f.requests).toHaveLength(2);
});
it("recomputes saved parameters instead of trusting a copied old fingerprint", async () => {
  const f = await setup();
  await updateNativeConnector(
    f.record.connectionId,
    nativeOAuthGuard(f.record),
    nativeOAuthClientClassification(),
    (current) => {
      current.configuration.parameters.resource = `${f.state.resource}/forged`;
      return current;
    },
  );
  const forged = requireNativeOAuthRecord(f.record.connectionId);
  await expect(
    f.driver.configure({ ...f.edit, revision: forged.revision }),
  ).rejects.toThrow();
  expect(requireNativeOAuthRecord(f.record.connectionId)).toEqual(forged);
  expect(f.requests).toHaveLength(2);
});
it("never revives actually withdrawn access and does not accept a stale editor revision", async () => {
  const f = await setup();
  await expect(
    f.driver.configure({ ...f.edit, revision: f.edit.revision - 1 }),
  ).rejects.toThrow();
  f.state.resourceDenied = true;
  await expect(
    f.driver.invoke(f.record.connectionId, "provider.resource.read", {}),
  ).rejects.toThrow();
  const withdrawn = requireNativeOAuthRecord(f.record.connectionId);
  expect(readNativeConnector(f.record.connectionId)?.status).toBe(
    "reauthorize",
  );
  await expect(
    f.driver.configure({ ...f.edit, revision: withdrawn.revision }),
  ).rejects.toThrow();
  expect(requireNativeOAuthRecord(f.record.connectionId)).toEqual(withdrawn);
  expect(f.requests).toHaveLength(3);
});
it("refuses the original owner cancelled while metadata commits", async () => {
  const f = await setup();
  f.local.beforeAtomicWrite(async () => {
    f.controller.abort();
  });
  await expect(
    f.driver.configure({ ...f.edit, displayName: "Must not commit" }),
  ).rejects.toThrow();
  f.local.beforeAtomicWrite();
  expect(requireNativeOAuthRecord(f.record.connectionId)).toEqual(f.record);
  expect(f.requests).toHaveLength(2);
});
it("does not bypass cleanup while a real consent attempt is pending", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closes.push(f.close);
  const saved = await configureNativeOAuthClient(f.input, f.owner);
  const { beginNativeOAuthClient } = await import(
    "./native-oauth-client-config.js"
  );
  await beginNativeOAuthClient(saved.connectionId, f.owner);
  const pending = requireNativeOAuthRecord(saved.connectionId);
  await expect(
    configureNativeOAuthClient(
      {
        ...f.input,
        connectionId: pending.connectionId,
        revision: pending.revision,
        credentials: { client_secret: "" },
      },
      f.owner,
    ),
  ).rejects.toMatchObject({ code: "cleanup" });
  expect(requireNativeOAuthRecord(saved.connectionId)).toEqual(pending);
  expect(f.requests).toEqual([]);
});

it("refuses expired authority without extending the original expiry or activating its proof", async () => {
  const f = await setup();
  await updateNativeConnector(
    f.record.connectionId,
    nativeOAuthGuard(f.record),
    nativeOAuthClientClassification(),
    (current) => {
      const expiry = Date.now() - 1000;
      current.privateState.grants.user.expiresAt = expiry;
      current.runtime.grants[0].expiresAt = expiry;
      return current;
    },
  );
  const expired = requireNativeOAuthRecord(f.record.connectionId);
  await expect(
    f.driver.configure({ ...f.edit, revision: expired.revision }),
  ).rejects.toThrow();
  expect(requireNativeOAuthRecord(f.record.connectionId)).toEqual(expired);
  expect(f.requests).toHaveLength(2);
});
