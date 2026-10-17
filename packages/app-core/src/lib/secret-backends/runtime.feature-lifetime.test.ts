import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceConnection } from "../device-connectors.js";
import { createSecretBackend } from "./factory.js";
import { secretBackendDraft } from "./presets.js";
import {
  disposeSecretBackendProbe,
  holdSecretBackend,
} from "./runtime-admission.js";
import {
  connectSecretBackend,
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
import { secretBackendSessionClosure } from "./sessions.js";
import { bindSecretBackendTransport } from "./transport.js";
import type { SecretBackend } from "./types.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let feature: AbortController;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await runtimeFixture();
  feature = new AbortController();
  releases.push(
    bindSecretBackendTransport({
      signal: feature.signal,
      assertCurrent() {},
      fetch: fixture.fetcher,
    }),
  );
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await fixture.close();
});
function captureFactory(cleanup?: () => Promise<void>) {
  const backends: SecretBackend[] = [];
  vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockImplementation(
    async (mode, check, signal) => {
      const backend = await createSecretBackend(mode, check, signal);
      const disconnect = backend.disconnect.bind(backend);
      vi.spyOn(backend, "disconnect").mockImplementation(async (session) => {
        await disconnect(session);
        await cleanup?.();
      });
      backends.push(backend);
      return backend;
    },
  );
  return backends;
}

it.each(["hung", "rejected"] as const)(
  "withdraws idle feature admission before %s cleanup",
  async (mode) => {
    const backends = captureFactory(() =>
      mode === "hung"
        ? new Promise(() => {})
        : Promise.reject(new Error("Private cleanup failure")),
    );
    const saved = await saveSecretBackendConnection(remoteDraft());
    const open = await connectSecretBackend(saved.connectionId);
    const original = open.session;
    const revision = status.snapshot();
    const sealed = fixture.files.get(ledgerFile);
    const requests = fixture.fetcher.mock.calls.length;
    const observer = vi.fn(() => {
      expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
      expect(backends[0]?.disconnect).not.toHaveBeenCalled();
    });
    releases.push(status.subscribe(observer));
    feature.abort("private capability reason");
    expect(open.signal?.aborted).toBe(true);
    expect(open.session).toBe(original);
    expect(Object.isFrozen(original)).toBe(true);
    expect(status.snapshot()).toBe(revision + 1);
    expect(observer).toHaveBeenCalledOnce();
    expect(fixture.files.get(ledgerFile)).toBe(sealed);
    await vi.waitFor(() =>
      expect(backends[0]?.disconnect).toHaveBeenCalledExactlyOnceWith(original),
    );
    await expect(open.backend.listItems(original)).rejects.toMatchObject({
      code: "stale",
    });
    expect(fixture.fetcher).toHaveBeenCalledTimes(requests);
  },
);

it("keeps a replacement on its captured feature after old release and abort", async () => {
  const backends = captureFactory();
  const saved = await saveSecretBackendConnection(remoteDraft());
  const second = await saveSecretBackendConnection(remoteDraft());
  const old = await connectSecretBackend(saved.connectionId);
  const next = new AbortController();
  const fetcher = vi.fn((...args: Parameters<typeof fixture.fetcher>) =>
    fixture.fetcher(...args),
  );
  releases.push(
    bindSecretBackendTransport({
      signal: next.signal,
      assertCurrent() {},
      fetch: fetcher,
    }),
  );
  releases[0]?.();
  const replacement = await connectSecretBackend(second.connectionId);
  const revision = status.snapshot();
  feature.abort();
  expect(old.signal?.aborted).toBe(true);
  expect(replacement.signal?.aborted).toBe(false);
  expect(status.snapshot()).toBe(revision + 1);
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  expect(deviceConnection(second.connectionId)?.status).toBe("active");
  expect(await replacement.backend.listItems(replacement.session)).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.waitFor(() =>
    expect(backends[0]?.disconnect).toHaveBeenCalledOnce(),
  );
  await replacement.backend.disconnect(replacement.session);
});

it("rejects admission when its status observer disables the captured feature", async () => {
  const backends = captureFactory();
  const saved = await saveSecretBackendConnection(remoteDraft());
  const revision = status.snapshot();
  releases.push(status.subscribe(() => feature.abort()));
  await expect(connectSecretBackend(saved.connectionId)).rejects.toMatchObject({
    code: "stale",
  });
  expect(status.snapshot()).toBe(revision + 2);
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  await vi.waitFor(() =>
    expect(backends[0]?.disconnect).toHaveBeenCalledOnce(),
  );
});

it.each(["resolve", "reject"] as const)(
  "rejects in-flight HTTP before its noncooperative late %s",
  async (late) => {
    const open = await connectSecretBackend(remoteDraft());
    const response = deferred<Response>();
    const failure = new Error("Private late HTTP error");
    fixture.fetcher.mockImplementationOnce(async () => {
      const result = await response.promise;
      if (late === "reject") throw failure;
      return result;
    });
    const operation = open.backend.listItems(open.session);
    const cancelled = expect(operation).rejects.toMatchObject({
      code: "stale",
    });
    await vi.waitFor(() => expect(fixture.fetcher).toHaveBeenCalledTimes(2));
    feature.abort();
    expect(fixture.fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    await cancelled;
    const nextFetch = vi.fn((...args: Parameters<typeof fixture.fetcher>) =>
      fixture.fetcher(...args),
    );
    releases.push(
      bindSecretBackendTransport({
        signal: new AbortController().signal,
        assertCurrent() {},
        fetch: nextFetch,
      }),
    );
    const globalFetch = vi.spyOn(globalThis, "fetch");
    response.resolve(Response.json([]));
    await Promise.resolve();
    expect(open.signal?.aborted).toBe(true);
    expect(nextFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  },
);

function lease() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    current: () => !controller.signal.aborted,
    check: vi.fn(),
    close: vi.fn(() => controller.abort()),
  };
}
async function rawBackend() {
  const backend = await createSecretBackend("onepassword-connect");
  const session = await backend.authenticate(remoteDraft());
  return { backend, session };
}

it.each(["already", "subscription"] as const)(
  "closes %s-ended backend admission without changing its opaque session",
  async (timing) => {
    const raw = await rawBackend();
    const signal = raw.backend.signal;
    if (!signal) throw new Error("Missing factory lifetime");
    const disconnect = vi.spyOn(raw.backend, "disconnect");
    if (timing === "already") feature.abort();
    else {
      const add = signal.addEventListener.bind(signal);
      vi.spyOn(signal, "addEventListener").mockImplementation((...args) => {
        add(...args);
        feature.abort();
      });
    }
    const closed = vi.fn();
    const held = holdSecretBackend(raw, lease(), closed);
    expect(held.signal.aborted).toBe(true);
    expect(held.current()).toBe(false);
    expect(() => held.check()).toThrow();
    expect(held.session).toBe(raw.session);
    expect(closed).toHaveBeenCalledOnce();
    await held.close();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(raw.session);
  },
);

it("reserves exact-session disposal before reentry and detaches captured listeners", async () => {
  const raw = await rawBackend();
  const signal = raw.backend.signal;
  if (!signal) throw new Error("Missing factory lifetime");
  const remove = vi.spyOn(signal, "removeEventListener");
  const dispose = raw.backend.disconnect.bind(raw.backend);
  const disconnect = vi
    .spyOn(raw.backend, "disconnect")
    .mockImplementation(async (session) => {
      expect(await raw.backend.listItems(session)).toEqual([]);
      await dispose(session);
    });
  const closed = vi.fn();
  const held = holdSecretBackend(raw, lease(), closed);
  let reentered: Promise<void> | undefined;
  held.signal.addEventListener("abort", () => {
    expect(disconnect).not.toHaveBeenCalled();
    reentered = held.backend.disconnect(raw.session);
  });
  const closing = held.close();
  expect(reentered).toBe(closing);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  await closing;
  expect(secretBackendSessionClosure(raw.session)).toBe("removed");
  await expect(raw.backend.listItems(raw.session)).rejects.toMatchObject({
    code: "authentication",
  });
  await expect(
    held.backend.disconnect({ ...raw.session }),
  ).rejects.toMatchObject({ code: "authentication" });
  feature.abort();
  expect(closed).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledExactlyOnceWith(raw.session);
});

it.each(["live", "ended"] as const)(
  "keeps normal provider removal distinct from %s feature during probe cleanup",
  async (lifetime) => {
    const cleanup = deferred<void>();
    const backends = captureFactory(() => cleanup.promise);
    const revision = status.snapshot();
    const completed = vi.fn();
    const probing = probeSecretBackend(remoteDraft()).then(completed);
    const settled =
      lifetime === "ended"
        ? expect(probing).rejects.toMatchObject({ code: "stale" })
        : probing;
    await vi.waitFor(() =>
      expect(backends[0]?.disconnect).toHaveBeenCalledOnce(),
    );
    const backend = backends[0];
    if (!backend) throw new Error("Missing captured backend");
    const session = vi.mocked(backend.disconnect).mock.calls[0]?.[0];
    if (!session) throw new Error("Missing exact probe session");
    expect(secretBackendSessionClosure(session)).toBe("removed");
    expect(completed).not.toHaveBeenCalled();
    if (lifetime === "ended") {
      feature.abort();
      await settled;
    }
    cleanup.resolve();
    await settled;
    expect(completed).toHaveBeenCalledTimes(lifetime === "live" ? 1 : 0);
    expect(backends[0]?.disconnect).toHaveBeenCalledOnce();
    expect(status.snapshot()).toBe(revision);
  },
);

it.each(["already", "final-check"] as const)(
  "rejects %s feature loss in direct probe and still attempts exact cleanup",
  async (timing) => {
    const raw = await rawBackend();
    const disconnect = vi.spyOn(raw.backend, "disconnect");
    const owner = lease();
    if (timing === "already") {
      feature.abort();
      disconnect.mockImplementation(() => new Promise(() => {}));
    } else owner.check.mockImplementation(() => feature.abort());
    await expect(disposeSecretBackendProbe(raw, owner)).rejects.toMatchObject({
      code: "stale",
    });
    await vi.waitFor(() =>
      expect(disconnect).toHaveBeenCalledExactlyOnceWith(raw.session),
    );
  },
);

it("exposes the exact captured transport signal without borrowing its replacement", async () => {
  const backend = await createSecretBackend("onepassword-connect");
  expect(backend.signal).toBe(feature.signal);
  const original = backend.signal;
  releases.push(
    bindSecretBackendTransport({
      signal: new AbortController().signal,
      assertCurrent() {},
      fetch: vi.fn(),
    }),
  );
  expect(backend.signal).toBe(original);
});

it.each(["local", "file-import", "credential-management"] as const)(
  "keeps %s independent from the external feature and owned by its caller",
  async (mode) => {
    const caller = new AbortController();
    const backend = await createSecretBackend(mode, undefined, caller.signal);
    expect(backend.signal).toBe(caller.signal);
    feature.abort();
    expect(backend.signal?.aborted).toBe(false);
    caller.abort();
    await expect(
      backend.authenticate({ ...remoteDraft(), mode }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(fixture.fetcher).not.toHaveBeenCalled();
  },
);

it("keeps an actual saved local vault connection active across unrelated feature disable", async () => {
  const saved = await saveSecretBackendConnection({
    ...secretBackendDraft("local-vault"),
    mode: "local",
  });
  const open = await connectSecretBackend(saved.connectionId);
  feature.abort();
  expect(open.signal?.aborted).toBe(false);
  expect(deviceConnection(saved.connectionId)?.status).toBe("active");
  expect(await open.backend.listItems(open.session)).toEqual(expect.any(Array));
  expect(fixture.fetcher).not.toHaveBeenCalled();
  await open.backend.disconnect(open.session);
});

it.each(["lease", "provider"] as const)(
  "does not attach dead listeners after %s subscription closes admission",
  async (source) => {
    const raw = await rawBackend();
    const backendSignal = raw.backend.signal;
    const providerSignal = raw.session.signal;
    if (!backendSignal || !providerSignal)
      throw new Error("Missing factory signals");
    const owner = lease();
    const backendAdd = vi.spyOn(backendSignal, "addEventListener");
    const providerAdd = vi.spyOn(providerSignal, "addEventListener");
    const target = source === "lease" ? owner.signal : providerSignal;
    const add = AbortSignal.prototype.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((...args) => {
      add(...args);
      owner.close();
    });
    const held = holdSecretBackend(raw, owner, vi.fn());
    expect(held.signal.aborted).toBe(true);
    expect(backendAdd).not.toHaveBeenCalled();
    if (source === "lease") expect(providerAdd).not.toHaveBeenCalled();
    await held.close();
  },
);
