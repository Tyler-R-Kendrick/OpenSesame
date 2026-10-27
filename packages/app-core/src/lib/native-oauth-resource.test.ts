import { expect, it } from "vitest";
import { removeNativeConnectorWithCleanup } from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { nativeOAuthClientClassification } from "./native-oauth-client-config.js";
import { CLIENT_SECRET } from "./native-oauth-client.test-support.js";
import {
  authorize,
  operations,
  setup,
} from "./native-oauth-resource.test-support.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import { runtimePassword } from "./secret-backends/runtime.test-support.js";
import { vaultStore } from "./vault/store.js";

it("activates only after the actual configured bearer resource and exposes the real project JSON", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  expect(saved.status).toBe("configuration");
  await authorize(f, saved.connectionId);
  const connected = readNativeConnector(saved.connectionId);
  expect(connected).toMatchObject({
    status: "connected",
    identity: {
      id: f.state.resource,
      kind: "api-resource",
      assurance: "credential-valid",
    },
  });
  const result = await f.driver.invoke(
    saved.connectionId,
    "provider.resource.read",
    {},
  );
  expect(JSON.parse(result.items[0]?.secretValue ?? "null")).toEqual({
    projects: [{ id: "project-42", name: "Actual configured project" }],
  });
  expect(f.requests.map((request) => request.path)).toEqual([
    "/token",
    "/resource",
    "/resource",
  ]);
  expect(f.requests[1]?.authorization).toBe("Bearer issued-access-1");
  expect(f.captureCounts().captures).toBe(f.captureCounts().released);
  await expect(
    f.driver.invoke(saved.connectionId, "provider.read", {}),
  ).rejects.toThrow();
});
it("uses the provider's documented POST verification contract", async () => {
  const f = await setup();
  f.input.providerId = "slack";
  f.input.parameters.resource = "https://slack.com/api/auth.test";
  f.state.resource = f.input.parameters.resource;
  const saved = await f.driver.configure(f.input);
  const providerFetch = f.owner.transport.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  f.owner.transport.fetch = async (input, init) => {
    const url = String(input);
    if (url !== "https://slack.com/api/auth.test")
      return providerFetch(input, init);
    calls.push({ url, init });
    return Response.json({ ok: true, team: "Protocol authority Slack team" });
  };
  await authorize(f, saved.connectionId);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.init?.method).toBe("POST");
  expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
    "Bearer issued-access-1",
  );
});
it("uses a templated provider endpoint and its documented credential header", async () => {
  const f = await setup();
  f.input.providerId = "shopify";
  f.input.parameters.resource =
    "https://contract-shop.myshopify.com/admin/oauth/access_scopes.json";
  f.state.resource = f.input.parameters.resource;
  const saved = await f.driver.configure(f.input);
  const providerFetch = f.owner.transport.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  f.owner.transport.fetch = async (input, init) => {
    const url = String(input);
    if (url !== f.state.resource) return providerFetch(input, init);
    calls.push({ url, init });
    return Response.json({
      access_scopes: [{ handle: "read_products" }],
    });
  };
  await authorize(f, saved.connectionId);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  const headers = new Headers(calls[0]?.init?.headers);
  expect(calls).toHaveLength(1);
  expect(headers.get("x-shopify-access-token")).toBe("issued-access-1");
  expect(headers.get("authorization")).toBeNull();
});
it("does not activate on a genuine resource401 and retains the minted grant for cleanup", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  f.state.resourceDenied = true;
  await expect(authorize(f, saved.connectionId)).rejects.toMatchObject({
    code: "authorization",
    status: 401,
  });
  const record = requireNativeOAuthRecord(saved.connectionId);
  expect(record.privateState.grants).toEqual({});
  expect(record.runtime.verifiedAt).toBeNull();
  expect(record.privateState.recovery[0]?.grant?.accessToken).toBe(
    "issued-access-1",
  );
  expect(f.requests.map((request) => request.path)).toEqual([
    "/token",
    "/resource",
  ]);
});
it("invalidates an active proof when the actual resource withdraws access", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  await authorize(f, saved.connectionId);
  f.state.resourceDenied = true;
  await expect(
    f.driver.invoke(saved.connectionId, "provider.resource.read", {}),
  ).rejects.toMatchObject({ status: 401 });
  expect(readNativeConnector(saved.connectionId)).toMatchObject({
    verifiedAt: null,
    status: "reauthorize",
  });
});
it("allows bad client→definitive rejection cleanup→corrected configuration→fresh real resource success", async () => {
  const f = await setup();
  const saved = await f.driver.configure({
    ...f.input,
    credentials: { client_secret: "wrong-client-secret" },
  });
  await expect(authorize(f, saved.connectionId)).rejects.not.toThrow(
    CLIENT_SECRET,
  );
  let record = requireNativeOAuthRecord(saved.connectionId);
  expect(record.privateState.recovery).toEqual([]);
  expect(record.privateState.recovery[0]?.grant).toBeUndefined();
  expect(JSON.stringify(record.privateState.recovery)).not.toContain(
    CLIENT_SECRET,
  );
  record = requireNativeOAuthRecord(saved.connectionId);
  expect(record.privateState.recovery).toEqual([]);
  const corrected = await f.driver.configure({
    ...f.input,
    connectionId: record.connectionId,
    revision: record.revision,
  });
  await authorize(f, corrected.connectionId);
  expect(readNativeConnector(corrected.connectionId)?.status).toBe("connected");
  expect(f.requests.map((request) => request.path)).toEqual([
    "/token",
    "/token",
    "/resource",
  ]);
});
it("cancels only the unexchanged generic pending request when the operator dismisses consent", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  f.cancel();
  await expect(authorize(f, saved.connectionId)).rejects.toThrow(
    "Operator dismissed consent",
  );
  const record = requireNativeOAuthRecord(saved.connectionId);
  expect(record.privateState.pending).toEqual({});
  expect(record.privateState.recovery).toEqual([]);
  expect(f.requests).toHaveLength(0);
});
it("does not deliver a held resource response after the original vault locks and the same tomb unlocks", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  f.state.holdResource = true;
  const operation = authorize(f, saved.connectionId);
  operations.push(operation);
  const rejected = expect(operation).rejects.toThrow();
  await f.entered.promise;
  vaultStore.lock();
  await vaultStore.unlock(runtimePassword);
  f.release.resolve();
  await rejected;
  const record = requireNativeOAuthRecord(saved.connectionId);
  expect(record.privateState.grants).toEqual({});
  expect(record.privateState.recovery[0]?.grant?.accessToken).toBe(
    "issued-access-1",
  );
  expect(f.requests.map((request) => request.path)).toEqual([
    "/token",
    "/resource",
  ]);
});
it.each(["issued", "rejected"])(
  "keeps the original %s exchange and an unrelated newer journal intact",
  async (outcome) => {
    const f = await setup();
    const saved = await f.driver.configure(f.input);
    f.state.hold = true;
    f.state.wrongClient = outcome === "rejected";
    const operation = authorize(f, saved.connectionId);
    operations.push(operation);
    const rejected = expect(operation).rejects.toThrow();
    await f.entered.promise;
    const record = requireNativeOAuthRecord(saved.connectionId);
    await updateNativeConnector(
      record.connectionId,
      nativeOAuthGuard(record),
      nativeOAuthClientClassification(),
      (current) => {
        current.privateState.recovery.push({
          id: "newer-independent-obligation",
          kind: "configure",
          providerId: f.input.providerId,
          actor: "user",
          fingerprint: current.configuration.fingerprint,
          targetId: "original-resource",
        });
        return current;
      },
    );
    f.controller.abort();
    f.release.resolve();
    await rejected;
    const current = requireNativeOAuthRecord(saved.connectionId);
    expect(current.privateState.recovery).toHaveLength(2);
    expect(
      current.privateState.recovery.find(
        (item) => item.id === "newer-independent-obligation",
      ),
    ).toBeTruthy();
    expect(current.privateState.grants).toEqual({});
  },
);
it("explicit disconnect forgets local grants without claiming provider revocation", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  await authorize(f, saved.connectionId);
  expect(await removeNativeConnectorWithCleanup(saved.connectionId)).toBe(true);
  expect(loadNativeConnectorRecord(saved.connectionId)).toBeNull();
  expect(f.requests.map((request) => request.path)).toEqual([
    "/token",
    "/resource",
  ]);
});

it.each(["unknown", "token-bearing", "network", "unexpected-field"] as const)(
  "retains an uncertain %s token exchange instead of interpreting it as definitive rejection",
  async (mode) => {
    const f = await setup();
    f.state.errorMode = mode;
    const saved = await f.driver.configure({
      ...f.input,
      credentials: { client_secret: "wrong-client-secret" },
    });
    await expect(authorize(f, saved.connectionId)).rejects.toThrow();
    const record = requireNativeOAuthRecord(saved.connectionId);
    expect(record.privateState.recovery).toHaveLength(1);
    expect(record.privateState.grants).toEqual({});
    if (mode === "token-bearing")
      expect(record.privateState.recovery[0]?.grant?.accessToken).toBe(
        "issued-access-1",
      );
    else
      expect(record.privateState.recovery[0]?.credentials?.phase).toBe(
        "exchange",
      );
    expect(f.requests).toHaveLength(1);
  },
);
