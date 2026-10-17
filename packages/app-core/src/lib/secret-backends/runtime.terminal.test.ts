import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceConnection } from "../device-connectors.js";
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
} from "./runtime.test-support.js";
import { secretBackendDeviceSeams as status } from "./seam.js";
import {
  createSecretBackendSessions,
  secretBackendSessionClosure,
} from "./sessions.js";
import { type SecretBackend, SecretBackendError } from "./types.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await fixture.close();
});
function nativeFixture() {
  const provider = new AbortController();
  const sessions = createSecretBackendSessions<{ token: string }>("fixture");
  const session = sessions.create(
    { token: "private lifecycle fixture" },
    provider.signal,
  );
  const backend = {
    id: "fixture",
    name: "Owned lifecycle fixture, no provider authentication",
    capabilities: {
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
      import: false,
    },
    authenticate: vi.fn<SecretBackend["authenticate"]>(async () => session),
    listItems: vi.fn<SecretBackend["listItems"]>(async (provided) => {
      expect(provided).toBe(session);
      sessions.read(provided);
      return [];
    }),
    getItem: vi.fn<SecretBackend["getItem"]>(),
    getNotes: vi.fn<SecretBackend["getNotes"]>(),
    disconnect: vi.fn<SecretBackend["disconnect"]>(async (provided) => {
      expect(provided).toBe(session);
      sessions.remove(provided);
    }),
  };
  return { provider, sessions, session, backend };
}
function install(raw: ReturnType<typeof nativeFixture>) {
  return vi
    .spyOn(secretBackendRuntimeSeams, "createBackend")
    .mockResolvedValue(raw.backend);
}

it.each(["hung", "rejected"] as const)(
  "withdraws idle admission and notifies before %s disposal",
  async (cleanup) => {
    const saved = await saveSecretBackendConnection(remoteDraft());
    const raw = nativeFixture();
    raw.backend.disconnect.mockImplementation(() =>
      cleanup === "hung"
        ? new Promise(() => {})
        : Promise.reject(new Error("Private disposal error")),
    );
    install(raw);
    const open = await connectSecretBackend(saved.connectionId);
    expect(open.session).toBe(raw.session);
    expect(open.signal).toBeInstanceOf(AbortSignal);
    expect(open.signal).not.toBe(raw.session.signal);
    const revision = status.snapshot();
    const files = [...fixture.files];
    const listener = vi.fn(() => {
      expect(status.snapshot()).toBe(revision + 1);
      expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
      expect(raw.backend.disconnect).not.toHaveBeenCalled();
    });
    releases.push(status.subscribe(listener));
    raw.provider.abort("private native reason");
    expect(open.signal?.aborted).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(status.snapshot()).toBe(revision + 1);
    expect([...fixture.files]).toEqual(files);
    expect(fixture.fetcher).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(raw.backend.disconnect).toHaveBeenCalledOnce(),
    );
    releases.pop()?.();
    raw.provider.abort();
    expect(status.snapshot()).toBe(revision + 1);
  },
);

it("keeps original private cleanup available and reentrant disposal idempotent", async () => {
  const raw = nativeFixture();
  const cleanup = deferred<void>();
  raw.backend.disconnect.mockImplementation(async (provided) => {
    expect(raw.sessions.read(provided).token).toBe("private lifecycle fixture");
    raw.sessions.remove(provided);
    await cleanup.promise;
  });
  install(raw);
  const open = await connectSecretBackend(remoteDraft());
  await open.backend.listItems(open.session);
  await expect(
    open.backend.listItems({ ...open.session }),
  ).rejects.toMatchObject({ code: "authentication" });
  expect(raw.backend.listItems).toHaveBeenCalledExactlyOnceWith(raw.session);
  let reentered: Promise<void> | undefined;
  open.signal?.addEventListener("abort", () => {
    reentered = open.backend.disconnect(open.session);
  });
  const closed = open.backend.disconnect(open.session);
  expect(reentered).toBe(closed);
  await expect(
    open.backend.disconnect({ ...open.session }),
  ).rejects.toMatchObject({ code: "authentication" });
  await vi.waitFor(() => expect(raw.backend.disconnect).toHaveBeenCalledOnce());
  expect(secretBackendSessionClosure(raw.session)).toBe("removed");
  cleanup.resolve();
  await closed;
  await open.backend.disconnect(open.session);
  expect(raw.backend.disconnect).toHaveBeenCalledOnce();
});

it.each([
  ["connect", "removed"],
  ["connect", "provider-ended"],
  ["probe", "removed"],
  ["probe", "provider-ended"],
] as const)(
  "refuses %s delivery of an already %s session without status admission",
  async (action, closure) => {
    const saved = await saveSecretBackendConnection(remoteDraft());
    const raw = nativeFixture();
    if (closure === "removed") raw.sessions.remove(raw.session);
    else raw.provider.abort();
    install(raw);
    const revision = status.snapshot();
    const pending =
      action === "connect"
        ? connectSecretBackend(saved.connectionId)
        : probeSecretBackend(remoteDraft(), saved.connectionId);
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    expect(status.snapshot()).toBe(revision);
    expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
    expect(raw.backend.disconnect).toHaveBeenCalledExactlyOnceWith(raw.session);
  },
);

it("refuses a provider that ends while admission subscribes", async () => {
  const raw = nativeFixture();
  install(raw);
  const signal = raw.session.signal;
  if (!signal) throw new Error("Expected common registry lifetime");
  const add = signal.addEventListener.bind(signal);
  vi.spyOn(signal, "addEventListener").mockImplementation((...args) => {
    add(...args);
    raw.provider.abort();
  });
  const revision = status.snapshot();
  await expect(connectSecretBackend(remoteDraft())).rejects.toMatchObject({
    code: "stale",
  });
  expect(status.snapshot()).toBe(revision);
  await vi.waitFor(() => expect(raw.backend.disconnect).toHaveBeenCalledOnce());
});

it.each(["resolve", "reject"] as const)(
  "discards a pending operation's late %s after provider loss",
  async (result) => {
    const raw = nativeFixture();
    const reply = deferred<void>();
    raw.backend.listItems.mockImplementationOnce(async () => {
      await reply.promise;
      if (result === "reject") throw new Error("Private late operation error");
      return [];
    });
    install(raw);
    const open = await connectSecretBackend(remoteDraft());
    const pending = open.backend.listItems(open.session);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    await vi.waitFor(() =>
      expect(raw.backend.listItems).toHaveBeenCalledOnce(),
    );
    raw.provider.abort();
    await cancelled;
    expect(open.signal?.aborted).toBe(true);
    reply.resolve();
    await expect(open.backend.listItems(open.session)).rejects.toMatchObject({
      code: "stale",
    });
    expect(raw.backend.listItems).toHaveBeenCalledOnce();
  },
);

it("waits for normal probe removal and delayed cleanup without any admission event", async () => {
  const raw = nativeFixture();
  const cleanup = deferred<void>();
  raw.backend.disconnect.mockImplementation(async (session) => {
    raw.sessions.remove(session);
    await cleanup.promise;
  });
  install(raw);
  const revision = status.snapshot();
  const completed = vi.fn();
  const probe = probeSecretBackend(remoteDraft()).then(completed);
  await vi.waitFor(() => expect(raw.backend.disconnect).toHaveBeenCalledOnce());
  expect(secretBackendSessionClosure(raw.session)).toBe("removed");
  expect(completed).not.toHaveBeenCalled();
  raw.provider.abort();
  cleanup.resolve();
  await probe;
  expect(completed).toHaveBeenCalledOnce();
  expect(status.snapshot()).toBe(revision);
});

it("rejects removal before the probe actually starts its intentional cleanup", async () => {
  const raw = nativeFixture();
  install(raw);
  const signal = raw.session.signal;
  if (!signal) throw new Error("Expected registry signal");
  const add = signal.addEventListener.bind(signal);
  vi.spyOn(signal, "addEventListener").mockImplementation((...args) => {
    add(...args);
    raw.sessions.remove(raw.session);
  });
  const revision = status.snapshot();
  await expect(probeSecretBackend(remoteDraft())).rejects.toMatchObject({
    code: "stale",
  });
  expect(status.snapshot()).toBe(revision);
  await vi.waitFor(() => expect(raw.backend.disconnect).toHaveBeenCalledOnce());
});

it.each(["provider-ended", "unknown"] as const)(
  "rejects %s loss during hung probe cleanup without admission",
  async (closure) => {
    const raw = nativeFixture();
    const external = new AbortController();
    if (closure === "unknown")
      raw.backend.authenticate.mockResolvedValue({
        ...raw.session,
        signal: external.signal,
      });
    raw.backend.disconnect.mockImplementation(() => new Promise(() => {}));
    install(raw);
    const revision = status.snapshot();
    const probe = probeSecretBackend(remoteDraft());
    const cancelled = expect(probe).rejects.toMatchObject({ code: "stale" });
    await vi.waitFor(() =>
      expect(raw.backend.disconnect).toHaveBeenCalledOnce(),
    );
    if (closure === "unknown") external.abort("untrusted reason");
    else raw.provider.abort("private native reason");
    await cancelled;
    expect(raw.backend.disconnect).toHaveBeenCalledOnce();
    expect(status.snapshot()).toBe(revision);
  },
);

it.each([403, 500, 429])(
  "keeps a live admitted session after ordinary HTTP %i operation failure",
  async (code) => {
    const raw = nativeFixture();
    install(raw);
    const saved = await saveSecretBackendConnection(remoteDraft());
    const open = await connectSecretBackend(saved.connectionId);
    const revision = status.snapshot();
    raw.backend.listItems.mockRejectedValueOnce(
      new SecretBackendError(
        code === 403 ? "authentication" : "response",
        `HTTP ${code}`,
      ),
    );
    await expect(open.backend.listItems(open.session)).rejects.toThrow(
      `HTTP ${code}`,
    );
    expect(open.signal?.aborted).toBe(false);
    expect(deviceConnection(saved.connectionId)?.status).toBe("active");
    expect(status.snapshot()).toBe(revision);
    expect(await open.backend.listItems(open.session)).toEqual([]);
    expect(raw.backend.authenticate).toHaveBeenCalledOnce();
    expect(raw.backend.disconnect).not.toHaveBeenCalled();
  },
);

it.each(["equal-id", "same-session"] as const)(
  "old %s holder cleanup cannot remove a replacement entry",
  async (reuse) => {
    const saved = await saveSecretBackendConnection(remoteDraft());
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const first = nativeFixture();
    const next = reuse === "same-session" ? first : nativeFixture();
    const cleanup = deferred<void>();
    first.backend.disconnect.mockImplementation(() => cleanup.promise);
    vi.spyOn(secretBackendRuntimeSeams, "createBackend")
      .mockResolvedValueOnce(first.backend)
      .mockResolvedValueOnce(next.backend);
    const old = await connectSecretBackend(saved.connectionId);
    const oldClosing = old.backend.disconnect(old.session);
    await vi.waitFor(() =>
      expect(first.backend.disconnect).toHaveBeenCalledOnce(),
    );
    const replacement = await connectSecretBackend(saved.connectionId);
    expect(replacement.session.id).toBe(old.session.id);
    expect(replacement.session === old.session).toBe(reuse === "same-session");
    const revision = status.snapshot();
    cleanup.resolve();
    await oldClosing;
    await old.backend.disconnect(old.session);
    if (reuse === "equal-id") first.provider.abort();
    expect(replacement.signal?.aborted).toBe(false);
    expect(status.snapshot()).toBe(revision);
    expect(deviceConnection(saved.connectionId)?.status).toBe("active");
    expect(await replacement.backend.listItems(replacement.session)).toEqual(
      [],
    );
    await replacement.backend.disconnect(replacement.session);
  },
);

it("does not return positive admission if a status observer ends the provider", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const raw = nativeFixture();
  install(raw);
  const stop = status.subscribe(() => raw.provider.abort());
  releases.push(stop);
  await expect(connectSecretBackend(saved.connectionId)).rejects.toMatchObject({
    code: "stale",
  });
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  await vi.waitFor(() => expect(raw.backend.disconnect).toHaveBeenCalledOnce());
});

it("snapshots status listeners and keeps an unsubscribed observer out of later transitions", async () => {
  const raw = nativeFixture();
  install(raw);
  const saved = await saveSecretBackendConnection(remoteDraft());
  const added = vi.fn();
  const first = vi.fn(() => releases.push(status.subscribe(added)));
  const stop = status.subscribe(first);
  releases.push(stop);
  const revision = status.snapshot();
  const open = await connectSecretBackend(saved.connectionId);
  expect(first).toHaveBeenCalledOnce();
  expect(added).not.toHaveBeenCalled();
  expect(status.snapshot()).toBe(revision + 1);
  expect(status.snapshot()).toBe(revision + 1);
  stop();
  await open.backend.disconnect(open.session);
  expect(first).toHaveBeenCalledOnce();
  expect(added).toHaveBeenCalledOnce();
  expect(status.snapshot()).toBe(revision + 2);
});
