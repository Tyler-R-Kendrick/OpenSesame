import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { readDeviceRows } from "./device-connector-records.js";
import * as kv from "./kv.js";
import {
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { bindNativeProviderTransport } from "./native-connector-transport.js";
import {
  configureNativeLocalInstance,
  readNativeLocalInstance,
  registerNativeLocalInstances,
  revokeNativeLocalInstanceToken,
  verifyNativeLocalInstance,
} from "./native-local-instance.js";

const token = "hvs.private-provider-token";
const input = {
  providerId: "vault" as const,
  displayName: "My Vault",
  icon: "",
  endpoint: "https://vault.example.org",
  namespace: "acme/engineering",
  apiKey: token,
};
const classification = {
  publicParameters: ["endpoint", "namespace"],
  privateCredentials: ["api_key"],
};
const lookup = {
  data: {
    id: token,
    accessor: "private-accessor",
    display_name: "Engineering service",
    entity_id: "entity-1",
    policies: ["default", "engineering-read"],
    ttl: 3600,
    renewable: true,
  },
};
const disposers: (() => void)[] = [];
function backend() {
  const memory = new Map<string, string>();
  const disk = new Map<string, string>();
  vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  vi.spyOn(kv.kvSeams, "kvSetDurable").mockImplementation(
    async (key, value) => {
      memory.set(key, value);
      disk.set(key, value);
    },
  );
  return {
    reload: () => {
      memory.clear();
      for (const [key, value] of disk) memory.set(key, value);
    },
  };
}
function provider() {
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(lookup), { status: 200 }),
  );
  disposers.push(
    bindNativeProviderTransport({ fetch: fetcher, assertCurrent: () => {} }),
  );
  disposers.push(registerNativeLocalInstances());
  return fetcher;
}
beforeEach(kv.kvForgetAll);
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  configureHost(createTestHost());
  forgetAtRestKeyForTest();
});

it.each(["vault", "openbao"] as const)(
  "verifies %s using exact origin and namespace and ignores secret-bearing lookup fields",
  async (providerId) => {
    const disk = backend();
    const fetcher = provider();
    const saved = await configureNativeLocalInstance({ ...input, providerId });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://vault.example.org/v1/auth/token/lookup-self");
    expect(new Headers(init?.headers).get("X-Vault-Token")).toBe(token);
    expect(new Headers(init?.headers).get("X-Vault-Namespace")).toBe(
      input.namespace,
    );
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      mode: "cors",
    });
    expect(saved.status).toBe("connected");
    expect(saved.identity?.id).toBe("entity-1");
    expect(saved.grants[0]?.permissionState).toBe("provider-managed");
    expect(saved.grants[0]?.grantedScopes).toEqual([]);
    disk.reload();
    expect(readNativeConnector(saved.connectionId)).toEqual(saved);
    expect(JSON.stringify(readDeviceRows())).not.toContain(token);
    expect(JSON.stringify(saved)).not.toContain("private-accessor");
    const facts = await readNativeLocalInstance(saved.connectionId);
    expect(facts.policies).toEqual(["default", "engineering-read"]);
    expect(JSON.stringify(facts)).not.toContain(token);
  },
);

it("does not invent an account when Vault returns a token without an entity", async () => {
  backend();
  const fetcher = provider();
  fetcher.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ data: { ...lookup.data, entity_id: "", ttl: 0 } }),
    ),
  );
  const saved = await configureNativeLocalInstance(input);
  expect(saved.status).toBe("connected");
  expect(saved.identity).toBeNull();
  expect(saved.grants[0]?.expiresAt).toBeNull();
});

it("keeps invalid or CORS-blocked credentials unconfigured and sanitizes upstream errors", async () => {
  backend();
  const fetcher = provider();
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ errors: [token] }), { status: 403 }),
  );
  await expect(configureNativeLocalInstance(input)).rejects.toThrow(
    "Provider permissions",
  );
  expect(readDeviceRows()).toEqual([]);
  fetcher.mockRejectedValueOnce(new Error(token));
  await expect(configureNativeLocalInstance(input)).rejects.toThrow(
    "Could not reach the provider from this browser",
  );
  expect(readDeviceRows()).toEqual([]);
});

it("refuses non-origin URLs and namespace header injection without credential egress", async () => {
  backend();
  const fetcher = provider();
  for (const endpoint of [
    "http://vault.example.org",
    "https://vault.example.org/path",
    "https://user:pass@vault.example.org",
    "https://vault.example.org/?token=private",
  ])
    await expect(
      configureNativeLocalInstance({ ...input, endpoint }),
    ).rejects.toThrow("HTTPS origin");
  await expect(
    configureNativeLocalInstance({
      ...input,
      namespace: "acme\r\nX-Evil: injected",
    }),
  ).rejects.toThrow("provider namespace");
  expect(fetcher).not.toHaveBeenCalled();
});

it("marks saved access incomplete immediately when the provider denies a later read", async () => {
  backend();
  const fetcher = provider();
  const saved = await configureNativeLocalInstance(input);
  fetcher.mockResolvedValueOnce(new Response("denied", { status: 403 }));
  await expect(readNativeLocalInstance(saved.connectionId)).rejects.toThrow(
    "Provider permissions",
  );
  expect(readNativeConnector(saved.connectionId)?.status).toBe("reauthorize");
});

it("requires explicit confirmation and journals a provider self-revocation before POST", async () => {
  backend();
  const fetcher = provider();
  const saved = await configureNativeLocalInstance(input);
  await expect(
    revokeNativeLocalInstanceToken(saved.connectionId, false),
  ).rejects.toThrow("Confirm provider token revocation");
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockImplementationOnce(async (url, init) => {
    expect(url).toBe("https://vault.example.org/v1/auth/token/revoke-self");
    expect(init?.method).toBe("POST");
    expect(readNativeConnector(saved.connectionId)?.status).toBe("cleanup");
    return new Response(null, { status: 204 });
  });
  await revokeNativeLocalInstanceToken(saved.connectionId, true);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("reauthorize");
  expect(readNativeConnector(saved.connectionId)?.recovery).toEqual([]);
});

it("keeps a lost self-revocation response durably retryable and distinguishes local disconnect", async () => {
  const disk = backend();
  const fetcher = provider();
  const saved = await configureNativeLocalInstance(input);
  fetcher.mockRejectedValueOnce(new Error("lost response"));
  await expect(
    revokeNativeLocalInstanceToken(saved.connectionId, true),
  ).rejects.toThrow("Provider cleanup failed");
  disk.reload();
  expect(readNativeConnector(saved.connectionId)?.status).toBe("cleanup");
  fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await retryNativeConnectorCleanup(saved.connectionId);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("reauthorize");
  const another = await configureNativeLocalInstance(input);
  const calls = fetcher.mock.calls.length;
  await removeNativeConnectorWithCleanup(another.connectionId);
  expect(fetcher.mock.calls.length).toBe(calls);
  expect(readNativeConnector(another.connectionId)).toBeNull();
});

it("refuses an awaited result when another update changes the record revision", async () => {
  backend();
  const fetcher = provider();
  const saved = await configureNativeLocalInstance(input);
  fetcher.mockImplementationOnce(async () => {
    await updateNativeConnector(
      saved.connectionId,
      saved,
      classification,
      (record) => {
        record.configuration.displayName = "Updated elsewhere";
        return record;
      },
    );
    return new Response(JSON.stringify(lookup));
  });
  await expect(readNativeLocalInstance(saved.connectionId)).rejects.toThrow(
    "Connector changed",
  );
  expect(
    readNativeConnector(saved.connectionId)?.configuration.displayName,
  ).toBe("Updated elsewhere");
});

it("revalidates an expired proof and publishes refreshed provider TTL without revealing the retained key", async () => {
  backend();
  const fetcher = provider();
  const saved = await configureNativeLocalInstance(input);
  await updateNativeConnector(
    saved.connectionId,
    saved,
    classification,
    (record) => {
      record.privateState.verification = null;
      record.runtime.verifiedAt = null;
      record.runtime.grants = record.runtime.grants.map((grant) => ({
        ...grant,
        needsReauth: true,
      }));
      return record;
    },
  );
  expect(readNativeConnector(saved.connectionId)?.status).toBe("reauthorize");
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ data: { ...lookup.data, ttl: 7200 } })),
  );
  const verified = await verifyNativeLocalInstance(saved.connectionId);
  expect(verified.status).toBe("connected");
  expect(verified.grants[0]?.expiresAt).toBeGreaterThan(
    saved.grants[0]?.expiresAt ?? 0,
  );
  expect(JSON.stringify(verified)).not.toContain(token);
});

it("retains a blank token only for its exact saved endpoint and namespace with the expected revision", async () => {
  backend();
  const fetcher = provider();
  const saved = await configureNativeLocalInstance(input);
  const edited = await configureNativeLocalInstance({
    ...input,
    connectionId: saved.connectionId,
    revision: saved.revision,
    apiKey: "",
    displayName: "Renamed",
  });
  expect(edited.status).toBe("connected");
  expect(edited.configuration.displayName).toBe("Renamed");
  expect(
    new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("X-Vault-Token"),
  ).toBe(token);
  const calls = fetcher.mock.calls.length;
  for (const changed of [
    { endpoint: "https://other.example.org" },
    { namespace: "another/team" },
    { providerId: "openbao" as const },
  ])
    await expect(
      configureNativeLocalInstance({
        ...input,
        ...changed,
        connectionId: saved.connectionId,
        apiKey: "",
      }),
    ).rejects.toThrow();
  await expect(
    configureNativeLocalInstance({
      ...input,
      connectionId: saved.connectionId,
      revision: saved.revision,
      apiKey: "",
    }),
  ).rejects.toThrow("Connector changed");
  expect(fetcher.mock.calls.length).toBe(calls);
});

it("refuses renewed proof when configuration changes while lookup is awaiting", async () => {
  backend();
  const fetcher = provider();
  const saved = await configureNativeLocalInstance(input);
  fetcher.mockImplementationOnce(async () => {
    await updateNativeConnector(
      saved.connectionId,
      saved,
      classification,
      (record) => {
        record.configuration.displayName = "Concurrent edit";
        return record;
      },
    );
    return new Response(JSON.stringify(lookup));
  });
  await expect(verifyNativeLocalInstance(saved.connectionId)).rejects.toThrow(
    "Connector changed",
  );
  expect(
    readNativeConnector(saved.connectionId)?.configuration.displayName,
  ).toBe("Concurrent edit");
});
