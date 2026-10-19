import { type ChannelListener, channel } from "node:diagnostics_channel";
import { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { nativeOAuthClientClassification } from "./native-oauth-client-config.js";
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
const closes: (() => Promise<void>)[] = [];
const operations: Promise<unknown>[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  await Promise.allSettled(operations.splice(0));
});
async function setup() {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closes.push(f.close);
  let cancelled = false;
  const unbind = bindNativeOAuthBrowserPort({
    redirectUri: f.owner.redirectUri,
    navigate: () => {
      throw new Error("Unexpected navigation");
    },
    scrubCallback: () => {},
    authorize: async (url) => {
      if (cancelled) throw new Error("Operator dismissed consent");
      const target = new URL(url);
      f.state.challenge = target.searchParams.get("code_challenge") ?? "";
      return new URLSearchParams({
        native_state: target.searchParams.get("state") ?? "",
        native_code: "one-use-code",
      }).toString();
    },
  });
  closes.push(async () => unbind());
  let capturedSignal: AbortSignal | undefined;
  let captures = 0;
  let released = 0;
  const driver = createNativeOAuthResourceDriver({
    supports: (id) => id === f.input.providerId,
    capture: async (signal) => {
      signal?.throwIfAborted();
      capturedSignal = signal;
      const guard = localVaultSessionGuard(vaultStore);
      captures++;
      const base = f.owner.transport;
      const transport: NativeProviderTransport = {
        ...base,
        assertCurrent: () => {
          base.assertCurrent();
          guard.current();
        },
      };
      return {
        ...f.owner,
        transport,
        close: () => {
          guard.close();
          released++;
        },
      };
    },
  });
  const unregister = registerNativeProviderCleanup(
    f.input.providerId,
    driver.cleanup,
  );
  closes.push(async () => unregister());
  return {
    ...f,
    driver,
    cancel: () => {
      cancelled = true;
    },
    captureCounts: () => ({ captures, released }),
    capturedSignal: () => capturedSignal,
  };
}
function authorize(f: Awaited<ReturnType<typeof setup>>, id: string) {
  if (!f.driver.authorize)
    throw new Error("Missing actual authorization driver");
  return f.driver.authorize(id);
}
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

it("physically closes a held TLS resource on caller cancellation and retains independent original operations", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  await authorize(f, saved.connectionId);
  const cancelled = new AbortController();
  cancelled.abort();
  const beforeAbort = f.captureCounts();
  const beforeRequests = f.requests.length;
  await expect(
    f.driver.invoke(
      saved.connectionId,
      "provider.resource.read",
      {},
      cancelled.signal,
    ),
  ).rejects.toThrow();
  expect(f.captureCounts()).toEqual(beforeAbort);
  expect(f.requests).toHaveLength(beforeRequests);
  const event = z.object({
    request: z.instanceof(IncomingMessage),
    response: z.instanceof(ServerResponse),
  });
  const actualServer = channel("http.server.request.start");
  let closed = false;
  const observe: ChannelListener = (message) => {
    const actual = event.parse(message);
    if (
      actual.request.url === "/resource" &&
      actual.request.headers.host === new URL(f.state.resource).host
    )
      actual.response.once("close", () => {
        closed = !actual.response.writableEnded;
      });
  };
  actualServer.subscribe(observe);
  closes.push(async () => {
    actualServer.unsubscribe(observe);
  });
  f.state.holdResource = true;
  const caller = new AbortController();
  const before = f.captureCounts();
  const operation = f.driver.invoke(
    saved.connectionId,
    "provider.resource.read",
    {},
    caller.signal,
  );
  operations.push(operation);
  const rejected = expect(operation).rejects.toThrow();
  expect(f.captureCounts().captures).toBe(before.captures + 1);
  expect(f.capturedSignal()).toBe(caller.signal);
  await f.entered.promise;
  const started = performance.now();
  caller.abort();
  await rejected;
  await expect.poll(() => closed, { timeout: 2000 }).toBe(true);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(f.controller.signal.aborted).toBe(false);
  expect(f.captureCounts().captures).toBe(f.captureCounts().released);
  f.release.resolve();
  f.state.holdResource = false;
  const independent = await f.driver.invoke(
    saved.connectionId,
    "provider.resource.read",
    {},
  );
  expect(JSON.parse(independent.items[0]?.secretValue ?? "null")).toEqual({
    projects: [{ id: "project-42", name: "Actual configured project" }],
  });
});
