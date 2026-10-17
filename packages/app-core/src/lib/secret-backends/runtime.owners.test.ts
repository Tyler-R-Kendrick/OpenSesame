import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceConnection } from "../device-connectors.js";
import { createInfisicalBackend } from "./infisical.js";
import * as guards from "./runtime-guard.js";
import {
  advanceSecretBackendGeneration as advance,
  secretBackendGeneration as generation,
  registerPendingSecretBackend as register,
} from "./runtime-owners.js";
import {
  connectSecretBackend,
  deleteSecretBackendConnection,
  probeSecretBackend,
  saveSecretBackendConnection,
  secretBackendRuntimeSeams,
} from "./runtime.js";
import {
  deferred,
  ledgerFile,
  remoteDraft,
  runtimeFixture,
} from "./runtime.test-support.js";
import { secretBackendDeviceSeams as status } from "./seam.js";
import { createSecretBackendSessions } from "./sessions.js";
import * as store from "./store.js";
import { bindSecretBackendTransport } from "./transport.js";
import type { SecretBackend, SecretBackendSession } from "./types.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let feature: AbortController;
let unbind: () => void;
beforeEach(async () => {
  fixture = await runtimeFixture();
  feature = new AbortController();
  unbind = bindSecretBackendTransport({
    signal: feature.signal,
    assertCurrent() {},
    fetch: fixture.fetcher,
  });
});
afterEach(async () => {
  unbind();
  await fixture.close();
});
function attempt(
  action: "connect" | "probe",
  id?: string,
  signal?: AbortSignal,
) {
  return action === "connect"
    ? connectSecretBackend(id ?? remoteDraft(), undefined, signal)
    : probeSecretBackend(remoteDraft(), id, signal);
}
function delayRequests(count: number) {
  const signals: AbortSignal[] = [];
  const reply = deferred<Response>();
  fixture.fetcher.mockImplementation((input, options) => {
    if (signals.length >= count)
      return Promise.resolve(
        Response.json(String(input).endsWith("/items") ? [] : { id: "vault" }),
      );
    const signal = options?.signal;
    if (!signal) throw new Error("Missing captured HTTP signal");
    signals.push(signal);
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Fixture request aborted")),
        { once: true },
      );
      void reply.promise.then(resolve);
    });
  });
  return { signals, reply };
}

it.each(["connect", "probe"] as const)(
  "refuses an already-ended %s caller before capture/hydration/factory",
  async (action) => {
    const capture = vi.spyOn(guards, "secretBackendVaultGuard");
    const hydrate = vi.spyOn(store, "hydrateSecretBackendConnections");
    const factory = vi.spyOn(secretBackendRuntimeSeams, "createBackend");
    await expect(
      attempt(action, undefined, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "stale" });
    expect(capture).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  },
);

it.each(["late", "publication"] as const)(
  "closes a %s vault capture without future hydration or authentication",
  async (timing) => {
    const guard = await guards.secretBackendVaultGuard();
    const close = vi.spyOn(guard, "close");
    const captured = deferred<typeof guard>();
    const caller = new AbortController();
    if (timing === "publication")
      void captured.promise.then(() => queueMicrotask(() => caller.abort()));
    const capture = vi
      .spyOn(guards, "secretBackendVaultGuard")
      .mockReturnValueOnce(captured.promise);
    const hydrate = vi.spyOn(store, "hydrateSecretBackendConnections");
    const pending = attempt("connect", undefined, caller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    if (timing === "late") {
      caller.abort();
      await cancelled;
    }
    captured.resolve(guard);
    await cancelled;
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(guard.current()).toBe(false);
    expect(hydrate).not.toHaveBeenCalled();
    expect(fixture.fetcher).not.toHaveBeenCalled();
  },
);

it.each(["connect", "probe"] as const)(
  "cancels %s hydration and ignores its uncancellable late completion",
  async (action) => {
    const hydrated = deferred<void>();
    const hydrate = vi
      .spyOn(store, "hydrateSecretBackendConnections")
      .mockReturnValueOnce(hydrated.promise);
    const factory = vi.spyOn(secretBackendRuntimeSeams, "createBackend");
    const caller = new AbortController();
    const pending = attempt(action, undefined, caller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    await vi.waitFor(() => expect(hydrate).toHaveBeenCalledOnce());
    caller.abort();
    await cancelled;
    hydrated.resolve();
    await Promise.resolve();
    expect(factory).not.toHaveBeenCalled();
  },
);

it.each(["connect", "probe"] as const)(
  "forwards %s caller cancellation to the captured fetch signal before reply flush",
  async (action) => {
    const saved = await saveSecretBackendConnection(remoteDraft());
    const { signals, reply } = delayRequests(1);
    const caller = new AbortController();
    const revision = status.snapshot();
    const sealed = fixture.files.get(ledgerFile);
    const configuration = store.readSecretBackendConnection(saved.connectionId);
    const pending = attempt(action, saved.connectionId, caller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    caller.abort();
    expect(signals[0]?.aborted).toBe(true);
    expect(feature.signal.aborted).toBe(false);
    await cancelled;
    expect(status.snapshot()).toBe(revision);
    expect(fixture.files.get(ledgerFile)).toBe(sealed);
    expect(store.readSecretBackendConnection(saved.connectionId)).toEqual(
      configuration,
    );
    reply.resolve(Response.json({ id: "vault" }));
    expect(fixture.fetcher).toHaveBeenCalledOnce();
  },
);

it.each(["edit", "delete", "reconnect"] as const)(
  "%s advance cancels every concurrent probe before HTTP reply flush",
  async (change) => {
    const saved = await saveSecretBackendConnection(remoteDraft());
    const { signals, reply } = delayRequests(2);
    const probes = [
      attempt("probe", saved.connectionId),
      attempt("probe", saved.connectionId),
    ];
    const cancelled = Promise.all(
      probes.map((probe) =>
        expect(probe).rejects.toMatchObject({ code: "stale" }),
      ),
    );
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    if (change === "edit")
      await saveSecretBackendConnection(
        { ...remoteDraft(), name: "Edited" },
        saved.connectionId,
      );
    else if (change === "delete")
      await deleteSecretBackendConnection(saved.connectionId);
    else {
      const replacement = await connectSecretBackend(saved.connectionId);
      await replacement.backend.disconnect(replacement.session);
    }
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(feature.signal.aborted).toBe(false);
    await cancelled;
    reply.resolve(Response.json({ id: "vault" }));
    expect(fixture.fetcher).toHaveBeenCalledTimes(
      change === "reconnect" ? 3 : 2,
    );
  },
);

it("keeps successful admission caller-owned until that caller ends", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const caller = new AbortController();
  const open = await connectSecretBackend(
    saved.connectionId,
    undefined,
    caller.signal,
  );
  expect(open.signal?.aborted).toBe(false);
  expect(await open.backend.listItems(open.session)).toEqual([]);
  fixture.fetcher.mockClear();
  caller.abort();
  expect(open.signal?.aborted).toBe(true);
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  await expect(open.backend.listItems(open.session)).rejects.toMatchObject({
    code: "stale",
  });
  expect(fixture.fetcher).not.toHaveBeenCalled();
});

it("a superseded connect and its old caller cannot close the newer admitted owner", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const { signals, reply } = delayRequests(1);
  const oldCaller = new AbortController();
  const old = connectSecretBackend(
    saved.connectionId,
    undefined,
    oldCaller.signal,
  );
  const cancelled = expect(old).rejects.toMatchObject({ code: "stale" });
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  const replacement = await connectSecretBackend(saved.connectionId);
  await cancelled;
  oldCaller.abort();
  reply.resolve(Response.json({ id: "vault" }));
  expect(replacement.signal?.aborted).toBe(false);
  expect(deviceConnection(saved.connectionId)?.status).toBe("active");
  await replacement.backend.disconnect(replacement.session);
});

it.each([
  ["late", "hung"],
  ["late", "rejected"],
  ["publication", "hung"],
  ["publication", "rejected"],
] as const)(
  "disposes an unsaved caller's %s auth once despite %s cleanup",
  async (timing, cleanup) => {
    const sessions = createSecretBackendSessions<object>("fixture");
    const session = sessions.create({});
    const authenticated = deferred<SecretBackendSession>();
    const caller = new AbortController();
    if (timing === "publication")
      void authenticated.promise.then(() =>
        queueMicrotask(() => caller.abort()),
      );
    const authenticate = vi.fn<SecretBackend["authenticate"]>(
      () => authenticated.promise,
    );
    const disconnect = vi.fn<SecretBackend["disconnect"]>(async (provided) => {
      expect(provided).toBe(session);
      sessions.remove(provided);
      if (cleanup === "hung") await new Promise<void>(() => {});
      else throw new Error("Private cleanup failure");
    });
    vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockResolvedValue({
      ...createInfisicalBackend(),
      authenticate,
      disconnect,
    });
    const pending = connectSecretBackend(
      remoteDraft(),
      undefined,
      caller.signal,
    );
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    await vi.waitFor(() => expect(authenticate).toHaveBeenCalledOnce());
    if (timing === "late") {
      caller.abort();
      await cancelled;
    }
    authenticated.resolve(session);
    await cancelled;
    await vi.waitFor(() =>
      expect(disconnect).toHaveBeenCalledExactlyOnceWith(session),
    );
  },
);

function owner() {
  const lifetime = new AbortController();
  return { signal: lifetime.signal, close: vi.fn(() => lifetime.abort()) };
}
it("withdraws generation and old Set before abort, preserving reentrant new ownership", () => {
  const id = crypto.randomUUID();
  const before = generation(id);
  const first = owner();
  const second = owner();
  const replacement = owner();
  const releaseFirst = register(id, before, first);
  const releaseSecond = register(id, before, second);
  first.signal.addEventListener("abort", () => {
    expect(generation(id)).toBe(before + 1);
    register(id, before + 1, replacement);
  });
  expect(advance(id)).toBe(before + 1);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
  expect(replacement.close).not.toHaveBeenCalled();
  releaseFirst();
  releaseSecond();
  advance(id);
  expect(replacement.close).toHaveBeenCalledOnce();
});

it("released owners are not retained by future advances and stale registration cannot enter", () => {
  const id = crypto.randomUUID();
  const previous = generation(id);
  const completed = owner();
  const release = register(id, previous, completed);
  release();
  release();
  advance(id);
  expect(completed.close).not.toHaveBeenCalled();
  const stale = owner();
  expect(() => register(id, previous, stale)).toThrow(
    "The backend operation ended.",
  );
  expect(stale.close).toHaveBeenCalledOnce();
  advance(id);
  expect(stale.close).toHaveBeenCalledOnce();
});

it.each(["factory", "authentication", "cleanup"] as const)(
  "does not retain a saved pending owner after %s ends",
  async (stage) => {
    const saved = await saveSecretBackendConnection(remoteDraft());
    const owners = await import("./runtime-owners.js");
    const registration = vi.spyOn(owners, "registerPendingSecretBackend");
    const failure = new Error("Controlled fixture failure");
    const sessions = createSecretBackendSessions<object>("fixture");
    const session = sessions.create({});
    const authenticate = vi.fn<SecretBackend["authenticate"]>(async () => {
      if (stage === "authentication") throw failure;
      return session;
    });
    const disconnect = vi.fn<SecretBackend["disconnect"]>(async (provided) => {
      sessions.remove(provided);
      await new Promise<void>(() => {});
    });
    const factory = vi.spyOn(secretBackendRuntimeSeams, "createBackend");
    if (stage === "factory") factory.mockRejectedValueOnce(failure);
    else
      factory.mockResolvedValue({
        ...createInfisicalBackend(),
        authenticate,
        disconnect,
      });
    const pending = attempt(
      stage === "cleanup" ? "probe" : "connect",
      saved.connectionId,
    );
    const ended =
      stage === "cleanup"
        ? expect(pending).rejects.toMatchObject({ code: "stale" })
        : expect(pending).rejects.toBe(failure);
    if (stage === "cleanup") {
      await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
      advance(saved.connectionId);
    }
    await ended;
    const lease = registration.mock.calls[0]?.[2];
    if (!lease) throw new Error("Expected pending registration");
    const close = vi.spyOn(lease, "close");
    advance(saved.connectionId);
    expect(close).not.toHaveBeenCalled();
  },
);
