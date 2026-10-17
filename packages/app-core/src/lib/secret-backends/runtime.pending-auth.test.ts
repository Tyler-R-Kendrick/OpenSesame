import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceConnection } from "../device-connectors.js";
import { vaultStore } from "../vault/store.js";
import { createSecretBackend } from "./factory.js";
import { secretBackendDraft } from "./presets.js";
import { secretBackendVaultGuard } from "./runtime-guard.js";
import {
  connectSecretBackend,
  probeSecretBackend,
  saveSecretBackendConnection,
  secretBackendRuntimeSeams,
} from "./runtime.js";
import {
  deferred,
  remoteDraft,
  runtimeFixture,
  runtimePassword,
} from "./runtime.test-support.js";
import { createSecretBackendSessions } from "./sessions.js";
import { bindSecretBackendTransport } from "./transport.js";
import type { SecretBackend, SecretBackendSession } from "./types.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let feature: AbortController;
let release: () => void;
beforeEach(async () => {
  fixture = await runtimeFixture();
  feature = new AbortController();
  release = bindSecretBackendTransport({
    fetch: fixture.fetcher,
    signal: feature.signal,
    assertCurrent: () => feature.signal.throwIfAborted(),
  });
});
afterEach(async () => {
  release();
  await fixture.close();
});

function pendingBackend() {
  const sessions = createSecretBackendSessions<{ secret: string }>("fixture");
  const session = sessions.create({ secret: "private fixture value" });
  const authenticated = deferred<SecretBackendSession>();
  const disconnect = vi.fn<SecretBackend["disconnect"]>(async (provided) => {
    expect(provided).toBe(session);
    sessions.remove(provided);
  });
  const backend: SecretBackend = {
    id: "fixture",
    name: "Lifecycle fixture, no provider authentication",
    capabilities: {
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
      import: false,
    },
    authenticate: vi.fn(() => authenticated.promise),
    listItems: vi.fn(async () => []),
    getItem: vi.fn(),
    getNotes: vi.fn(),
    disconnect,
  };
  return { backend, session, authenticated, disconnect };
}

it.each(["connect", "probe"] as const)(
  "%s aborts the actual factory's captured HTTP signal before a delayed auth reply",
  async (action) => {
    const draft = {
      ...secretBackendDraft("infisical"),
      baseUrl: "https://infisical.example/",
      projectId: "project",
      environment: "dev",
      secretPath: "/",
      clientId: "machine",
      clientSecret: "fixture secret",
    };
    const saved = await saveSecretBackendConnection(draft);
    const entered = deferred<AbortSignal>();
    const reply = deferred<Response>();
    fixture.fetcher.mockImplementationOnce((_input, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Missing real forwarded request signal");
      entered.resolve(signal);
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("Request aborted")),
          { once: true },
        );
        void reply.promise.then(resolve);
      });
    });
    const pending =
      action === "connect"
        ? connectSecretBackend(saved.connectionId)
        : probeSecretBackend(draft, saved.connectionId);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    const requestSignal = await entered.promise;
    vaultStore.lock();
    expect(requestSignal.aborted).toBe(true);
    expect(feature.signal.aborted).toBe(false);
    await cancelled;
    expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
    reply.resolve(Response.json({ accessToken: "late access token" }));
    await Promise.resolve();
    expect(fixture.fetcher).toHaveBeenCalledOnce();
    expect(String(fixture.fetcher.mock.calls[0]?.[0])).toContain(
      "/auth/universal-auth/login",
    );
  },
);

it("captures vault cancellation before installing a post-auth invalidation callback", async () => {
  const guard = await secretBackendVaultGuard();
  const observe = vi.fn();
  guard.signal.addEventListener("abort", observe);
  vaultStore.lock();
  expect(guard.signal.aborted).toBe(true);
  expect(guard.current()).toBe(false);
  expect(observe).toHaveBeenCalledOnce();
  const invalidated = vi.fn();
  guard.onInvalidated(invalidated);
  expect(invalidated).toHaveBeenCalledOnce();
  guard.close();
  expect(observe).toHaveBeenCalledOnce();
});

it.each(["connect", "probe"] as const)(
  "cancels %s during a delayed factory without authenticating its late backend",
  async (action) => {
    const late = pendingBackend();
    const factory = deferred<SecretBackend>();
    const entered = deferred<AbortSignal>();
    vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockImplementation(
      (_mode, _check, signal) => {
        if (!signal) throw new Error("Missing pending owner");
        entered.resolve(signal);
        return factory.promise;
      },
    );
    const pending =
      action === "connect"
        ? connectSecretBackend(remoteDraft())
        : probeSecretBackend(remoteDraft());
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    const owner = await entered.promise;
    vaultStore.lock();
    await cancelled;
    expect(owner.aborted).toBe(true);
    factory.resolve(late.backend);
    await Promise.resolve();
    expect(late.backend.authenticate).not.toHaveBeenCalled();
    expect(fixture.fetcher).not.toHaveBeenCalled();
  },
);

it.each(["connect", "probe"] as const)(
  "%s disposes a noncooperative late session once without awaiting hung cleanup",
  async (action) => {
    const late = pendingBackend();
    late.disconnect.mockImplementation(async (session) => {
      expect(session).toBe(late.session);
      await new Promise<void>(() => {});
    });
    vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockResolvedValue(
      late.backend,
    );
    const pending =
      action === "connect"
        ? connectSecretBackend(remoteDraft())
        : probeSecretBackend(remoteDraft());
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    await vi.waitFor(() =>
      expect(late.backend.authenticate).toHaveBeenCalledOnce(),
    );
    vaultStore.lock();
    await cancelled;
    late.authenticated.resolve(late.session);
    await vi.waitFor(() =>
      expect(late.disconnect).toHaveBeenCalledExactlyOnceWith(late.session),
    );
    expect(feature.signal.aborted).toBe(false);
  },
);

it.each(["hung", "rejected"] as const)(
  "disposes a session once when lock wins the result-publication microtask and cleanup is %s",
  async (cleanup) => {
    const late = pendingBackend();
    late.disconnect.mockImplementation(() =>
      cleanup === "hung"
        ? new Promise(() => {})
        : Promise.reject(new Error("Cleanup rejected")),
    );
    late.backend.authenticate = vi.fn(() => {
      void late.authenticated.promise.then(() =>
        queueMicrotask(() => vaultStore.lock()),
      );
      return late.authenticated.promise;
    });
    const factory = vi
      .spyOn(secretBackendRuntimeSeams, "createBackend")
      .mockResolvedValue(late.backend);
    const pending = connectSecretBackend(remoteDraft());
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    await vi.waitFor(() =>
      expect(late.backend.authenticate).toHaveBeenCalledOnce(),
    );
    const owner = factory.mock.calls[0]?.[2];
    expect(owner?.aborted).toBe(false);
    late.authenticated.resolve(late.session);
    await cancelled;
    expect(owner?.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(late.disconnect).toHaveBeenCalledExactlyOnceWith(late.session),
    );
  },
);

it("cancels a probe whose post-auth disposal hangs, while normal probes await disposal", async () => {
  const raw = pendingBackend();
  const cleanup = deferred<void>();
  raw.disconnect.mockImplementation(() => cleanup.promise);
  vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockResolvedValue(
    raw.backend,
  );
  raw.authenticated.resolve(raw.session);
  const probe = probeSecretBackend(remoteDraft());
  const cancelled = expect(probe).rejects.toMatchObject({ code: "stale" });
  await vi.waitFor(() => expect(raw.disconnect).toHaveBeenCalledOnce());
  vaultStore.lock();
  await cancelled;
  expect(raw.disconnect).toHaveBeenCalledOnce();
  cleanup.resolve();
});

it("waits for successful probe disposal and ends its captured owner after cleanup", async () => {
  const raw = pendingBackend();
  const cleanup = deferred<void>();
  raw.disconnect.mockImplementation(() => cleanup.promise);
  const factory = vi
    .spyOn(secretBackendRuntimeSeams, "createBackend")
    .mockResolvedValue(raw.backend);
  raw.authenticated.resolve(raw.session);
  const completed = vi.fn();
  const probe = probeSecretBackend(remoteDraft()).then(completed);
  await vi.waitFor(() => expect(raw.disconnect).toHaveBeenCalledOnce());
  expect(completed).not.toHaveBeenCalled();
  const owner = factory.mock.calls[0]?.[2];
  expect(owner?.aborted).toBe(false);
  cleanup.resolve();
  await probe;
  expect(completed).toHaveBeenCalledOnce();
  expect(owner?.aborted).toBe(true);
});

it("cancels reconnect while previous session disposal hangs before the new factory", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const raw = pendingBackend();
  raw.authenticated.resolve(raw.session);
  raw.disconnect.mockImplementation(() => new Promise(() => {}));
  const factory = vi
    .spyOn(secretBackendRuntimeSeams, "createBackend")
    .mockResolvedValue(raw.backend);
  await connectSecretBackend(saved.connectionId);
  const pending = connectSecretBackend(saved.connectionId);
  const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
  await vi.waitFor(() => expect(raw.disconnect).toHaveBeenCalledOnce());
  vaultStore.lock();
  await cancelled;
  expect(factory).toHaveBeenCalledOnce();
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
});

it.each([1, 2] as const)(
  "preserves existing %i-argument factory seam implementations",
  async (count) => {
    vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockImplementation(
      (mode, check) =>
        count === 1
          ? createSecretBackend(mode)
          : createSecretBackend(mode, check),
    );
    const open = await connectSecretBackend(remoteDraft());
    expect(await open.backend.listItems(open.session)).toEqual([]);
    await open.backend.disconnect(open.session);
  },
);

it("an old cancelled owner's late cleanup cannot close a replacement vault session", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const old = pendingBackend();
  const factory = vi
    .spyOn(secretBackendRuntimeSeams, "createBackend")
    .mockResolvedValueOnce(old.backend);
  const pending = connectSecretBackend(saved.connectionId);
  const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
  await vi.waitFor(() =>
    expect(old.backend.authenticate).toHaveBeenCalledOnce(),
  );
  const oldOwner = factory.mock.calls[0]?.[2];
  vaultStore.lock();
  await cancelled;
  await vaultStore.unlock(runtimePassword);
  const replacement = await connectSecretBackend(saved.connectionId);
  const newOwner = factory.mock.calls[1]?.[2];
  old.authenticated.resolve(old.session);
  await vi.waitFor(() => expect(old.disconnect).toHaveBeenCalledOnce());
  expect(oldOwner?.aborted).toBe(true);
  expect(newOwner?.aborted).toBe(false);
  expect(deviceConnection(saved.connectionId)?.status).toBe("active");
  expect(await replacement.backend.listItems(replacement.session)).toEqual([]);
  await replacement.backend.disconnect(replacement.session);
});
