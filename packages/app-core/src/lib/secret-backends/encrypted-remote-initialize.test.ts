import { afterEach, expect, it, vi } from "vitest";
import { createEncryptedRemoteBackend } from "./encrypted-remote.js";
import {
  encryptedRemoteFixture,
  independentOpen,
} from "./encrypted-remote.test-support.js";
import { deferred, remoteDraft } from "./runtime.test-support.js";
import {
  fenceSecretBackend,
  guardSecretBackendTransport,
} from "./transport.js";
import type { SecretBackendSession } from "./types.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
it("fences separate explicit initialization while ordinary authentication leaves a missing object untouched", async () => {
  const f = await encryptedRemoteFixture();
  closes.push(f.close);
  f.state.missing = true;
  const backend = fenceSecretBackend(
    createEncryptedRemoteBackend(f.transport),
    f.transport,
  );
  const config = {
    ...remoteDraft(),
    baseUrl: f.config.objectUrl,
    remoteStoreId: f.config.storeId,
    encryptionKey: f.config.encryptionKey,
    token: f.config.bearerToken,
  };
  await expect(backend.authenticate(config)).rejects.toMatchObject({
    code: "not-found",
  });
  expect(f.requests.every((row) => row.method === "GET")).toBe(true);
  const session = await backend.initialize?.(config);
  if (!session) throw new Error("Initialization was not mounted.");
  expect(f.requests.filter((row) => row.method === "PUT")).toEqual([
    expect.objectContaining({ noneMatch: "*", match: "" }),
  ]);
  expect(independentOpen(f.state.bytes, f.config.objectUrl).items).toEqual([]);
  await backend.disconnect(session);
  const before = f.state.bytes;
  await expect(backend.initialize?.(config)).rejects.toMatchObject({
    code: "stale",
  });
  expect(f.state.bytes).toBe(before);
  f.rotateTarget();
  const count = f.requests.length;
  await expect(backend.initialize?.(config)).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
});

it.each(["owner", "target"] as const)(
  "discards an initialized opaque session returned after its %s is withdrawn",
  async (reason) => {
    const f = await encryptedRemoteFixture();
    closes.push(f.close);
    const source = createEncryptedRemoteBackend(f.transport);
    const session = await source.authenticate(f.config);
    const entered = deferred<void>();
    const completed = deferred<SecretBackendSession>();
    const initialize = vi.fn(async () => {
      entered.resolve();
      return completed.promise;
    });
    const disconnect = vi.fn((held: SecretBackendSession) =>
      source.disconnect(held),
    );
    const owner = new AbortController();
    let current = true;
    const transport = guardSecretBackendTransport(
      f.transport,
      () => {
        if (!current) throw new Error("Original initialization target changed");
      },
      owner.signal,
    );
    const backend = fenceSecretBackend(
      { ...fenceSecretBackend(source, f.transport), initialize, disconnect },
      transport,
    );
    const pending = backend.initialize?.(remoteDraft());
    if (!pending) throw new Error("Initialization was not mounted.");
    await entered.promise;
    const rejected = expect(pending).rejects.toThrow(
      reason === "owner" ? /changed|disabled/ : /target changed/,
    );
    if (reason === "owner") {
      owner.abort();
      await rejected;
      completed.resolve(session);
    } else {
      current = false;
      completed.resolve(session);
      await rejected;
    }
    await vi.waitFor(() =>
      expect(disconnect).toHaveBeenCalledExactlyOnceWith(session),
    );
    expect(session.signal?.aborted).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();
  },
);

it("refuses initialization before invoking the adapter when its owner already ended", async () => {
  const f = await encryptedRemoteFixture();
  closes.push(f.close);
  const source = createEncryptedRemoteBackend(f.transport);
  const initialize = vi.fn(source.initialize.bind(source));
  const owner = new AbortController();
  const backend = fenceSecretBackend(
    { ...fenceSecretBackend(source, f.transport), initialize },
    guardSecretBackendTransport(f.transport, undefined, owner.signal),
  );
  owner.abort();
  await expect(backend.initialize?.(remoteDraft())).rejects.toMatchObject({
    code: "stale",
  });
  expect(initialize).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(0);
});
