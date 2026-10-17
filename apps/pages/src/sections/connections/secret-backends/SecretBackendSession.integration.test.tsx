/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import type { SecretBackendHandle } from "@opensesame/app-core/lib/secret-backends/runtime-admission.js";
import type { SecretBackend } from "@opensesame/app-core/lib/secret-backends/types.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { secretBackendDependencies as dependencies } from "./secret-backend-dependencies.js";
import { useSecretBackendConnection } from "./useSecretBackendConnection.js";
import {
  type SecretBackendSessionAttempt,
  useSecretBackendSession,
} from "./useSecretBackendSession.js";

const locks = new Set<() => void>();
beforeEach(() => {
  vi.spyOn(vaultStore, "onLock").mockImplementation((callback) => {
    locks.add(callback);
    return () => locks.delete(callback);
  });
  vi.spyOn(dependencies, "listSecretBackendConnections").mockReturnValue([]);
  vi.spyOn(dependencies, "readSecretBackendConnection").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  locks.clear();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function rawHandle(id = "equal-public-id") {
  const lifetime = new AbortController();
  const provider = new AbortController();
  const session = Object.freeze({
    id,
    backendId: "fixture",
    authenticatedAt: "",
    signal: provider.signal,
  });
  const disconnect = vi.fn<SecretBackend["disconnect"]>(async (provided) => {
    expect(provided).toBe(session);
  });
  const backend: SecretBackend = {
    id: "fixture",
    name: "Controlled lifecycle fixture; no provider authentication",
    capabilities: {
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
      import: false,
    },
    authenticate: vi.fn(),
    listItems: vi.fn(),
    getItem: vi.fn(),
    getNotes: vi.fn(),
    disconnect,
  };
  const handle: SecretBackendHandle = {
    backend,
    session,
    signal: lifetime.signal,
  };
  return { handle, lifetime, provider, disconnect };
}
function sessionHook() {
  const ended = vi.fn();
  const view = renderHook(({ ended }) => useSecretBackendSession(ended), {
    initialProps: { ended },
  });
  return { ...view, ended };
}
function begin(
  view: { result: { current: ReturnType<typeof useSecretBackendSession> } },
  signal?: AbortSignal,
) {
  let attempt: SecretBackendSessionAttempt | undefined;
  act(() => {
    attempt = view.result.current.begin(signal);
  });
  if (!attempt) throw new Error("Missing session attempt");
  return attempt;
}
const provider: Provider = {
  id: "byo-secret-backend",
  displayName: "BYO",
  category: "developer",
  authKind: "configuration",
  configured: false,
  docsUrl: "https://example.com",
  supportsRefresh: false,
  autoConfigurable: false,
  missingConfig: [],
  callbackUrl: null,
  scopes: [],
  egress: { scheme: "https", authorities: [], pathPrefixes: [] },
  operations: [],
};
function connectionHook() {
  const onFlash = vi.fn();
  const onChanged = vi.fn();
  const view = renderHook(() =>
    useSecretBackendConnection({
      provider,
      connection: null,
      online: true,
      onFlash,
      onChanged,
    }),
  );
  return { ...view, onFlash, onChanged };
}

it("hands the dedicated caller to Connect and retains it after successful action completion", async () => {
  const raw = rawHandle();
  const connect = vi
    .spyOn(dependencies, "connectSecretBackend")
    .mockResolvedValue(raw.handle);
  const view = connectionHook();
  act(() => view.result.current.connect());
  await waitFor(() => expect(view.result.current.active).toBe(raw.handle));
  expect(view.result.current.busy).toBe(false);
  expect(view.result.current.result).toBe("Secret backend session connected");
  const signal = connect.mock.calls[0]?.[2];
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);
  expect(view.result.current.active?.session).toBe(raw.handle.session);
  act(() => raw.lifetime.abort("private terminal reason"));
  expect(view.result.current.active).toBeNull();
  expect(view.result.current.result).toBe("");
  expect(signal?.aborted).toBe(true);
  await waitFor(() =>
    expect(raw.disconnect).toHaveBeenCalledExactlyOnceWith(raw.handle.session),
  );
  expect(view.onFlash).not.toHaveBeenCalled();
});

it.each(["unmount", "lock", "clear"] as const)(
  "aborts pending Connect on %s before the controlled late handle is released",
  async (ending) => {
    const response = deferred<SecretBackendHandle>();
    const connect = vi
      .spyOn(dependencies, "connectSecretBackend")
      .mockReturnValue(response.promise);
    const raw = rawHandle();
    const view = connectionHook();
    act(() => view.result.current.connect());
    const signal = connect.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);
    act(() => {
      if (ending === "unmount") view.unmount();
      else if (ending === "lock") for (const lock of locks) lock();
      else view.result.current.clear();
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      response.resolve(raw.handle);
      await response.promise;
    });
    await waitFor(() =>
      expect(raw.disconnect).toHaveBeenCalledExactlyOnceWith(
        raw.handle.session,
      ),
    );
    if (ending !== "unmount") {
      expect(view.result.current.active).toBeNull();
      expect(view.result.current.result).toBe("");
      expect(view.result.current.busy).toBe(false);
    }
    expect(view.onFlash).not.toHaveBeenCalled();
    expect(view.onChanged).not.toHaveBeenCalled();
  },
);

it.each(["already", "delivery"] as const)(
  "never accepts an %s-ended handle from Connect",
  async (timing) => {
    const raw = rawHandle();
    const response = deferred<SecretBackendHandle>();
    if (timing === "already") raw.lifetime.abort();
    else void response.promise.then(() => raw.provider.abort());
    vi.spyOn(dependencies, "connectSecretBackend").mockReturnValue(
      response.promise,
    );
    const view = connectionHook();
    act(() => view.result.current.connect());
    await act(async () => {
      response.resolve(raw.handle);
      await response.promise;
    });
    expect(view.result.current.active).toBeNull();
    expect(view.result.current.result).toBe("");
    await waitFor(() => expect(raw.disconnect).toHaveBeenCalledOnce());
    expect(view.onFlash).not.toHaveBeenCalled();
  },
);

it.each(["handle", "provider"] as const)(
  "withdraws idle %s authority before hung or rejected disposal",
  async (signal) => {
    const raw = rawHandle();
    raw.disconnect.mockImplementation(() =>
      signal === "handle"
        ? new Promise(() => {})
        : Promise.reject(new Error("Private cleanup failure")),
    );
    const view = sessionHook();
    const attempt = begin(view);
    act(() =>
      expect(view.result.current.accept(attempt, raw.handle)).toBe(true),
    );
    expect(view.result.current.activeKey).toBeGreaterThan(0);
    act(() => (signal === "handle" ? raw.lifetime : raw.provider).abort());
    expect(view.result.current.active).toBeNull();
    expect(attempt.signal.aborted).toBe(true);
    expect(view.ended).toHaveBeenCalledOnce();
    await waitFor(() => expect(raw.disconnect).toHaveBeenCalledOnce());
    act(() => {
      raw.lifetime.abort();
      raw.provider.abort();
      view.result.current.end(attempt);
    });
    expect(view.ended).toHaveBeenCalledOnce();
    expect(raw.disconnect).toHaveBeenCalledOnce();
  },
);

it("uses only the latest committed terminal callback and keeps methods stable", async () => {
  const view = sessionHook();
  const { begin: originalBegin, accept, end, disconnect } = view.result.current;
  const raw = rawHandle();
  const attempt = begin(view);
  act(() => {
    view.result.current.accept(attempt, raw.handle);
  });
  const latest = vi.fn();
  view.rerender({ ended: latest });
  expect(view.result.current.begin).toBe(originalBegin);
  expect(view.result.current.accept).toBe(accept);
  expect(view.result.current.end).toBe(end);
  expect(view.result.current.disconnect).toBe(disconnect);
  act(() => raw.provider.abort());
  expect(view.ended).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
});

it("mints distinct child keys for equal public session IDs and isolates old cleanup", async () => {
  const view = sessionHook();
  const old = rawHandle();
  const next = rawHandle();
  const cleanup = deferred<void>();
  old.disconnect.mockImplementation(() => cleanup.promise);
  const first = begin(view);
  act(() => {
    view.result.current.accept(first, old.handle);
  });
  const firstKey = view.result.current.activeKey;
  const second = begin(view);
  act(() => {
    view.result.current.accept(second, next.handle);
  });
  expect(view.result.current.activeKey).not.toBe(firstKey);
  expect(next.handle.session.id).toBe(old.handle.session.id);
  expect(next.handle.session).not.toBe(old.handle.session);
  act(() => {
    old.provider.abort();
    view.result.current.end(first);
    cleanup.resolve();
  });
  expect(view.result.current.active).toBe(next.handle);
  expect(second.current()).toBe(true);
  expect(view.ended).not.toHaveBeenCalled();
});

it("does not overwrite B started reentrantly by the previous caller's abort during begin A", async () => {
  const view = sessionHook();
  const old = begin(view);
  let replacement: SecretBackendSessionAttempt | undefined;
  old.signal.addEventListener("abort", () => {
    replacement = view.result.current.begin();
  });
  const displaced = begin(view);
  const retained = replacement;
  if (!retained) throw new Error("Expected reentrant replacement");
  expect(displaced.signal.aborted).toBe(true);
  expect(displaced.current()).toBe(false);
  expect(retained.current()).toBe(true);
  const late = rawHandle();
  act(() => {
    expect(view.result.current.accept(displaced, late.handle)).toBe(false);
  });
  const next = rawHandle();
  act(() => {
    expect(view.result.current.accept(retained, next.handle)).toBe(true);
  });
  expect(view.result.current.active).toBe(next.handle);
  await waitFor(() => expect(late.disconnect).toHaveBeenCalledOnce());
  expect(next.disconnect).not.toHaveBeenCalled();
});

it("detaches pending cancellation and preserves the accepted owner against an ended attempt", () => {
  const view = sessionHook();
  const action = new AbortController();
  const remove = vi.spyOn(action.signal, "removeEventListener");
  const raw = rawHandle();
  const attempt = begin(view, action.signal);
  act(() => {
    expect(view.result.current.accept(attempt, raw.handle)).toBe(true);
    action.abort();
  });
  const alreadyEnded = begin(view, action.signal);
  expect(alreadyEnded.signal.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(attempt.current()).toBe(true);
  expect(attempt.signal.aborted).toBe(false);
  expect(view.result.current.active).toBe(raw.handle);
  act(() => view.result.current.disconnect());
  expect(attempt.signal.aborted).toBe(true);
  expect(view.ended).not.toHaveBeenCalled();
});

it("closes late handles exactly once after unmount and never revives a stale begin", async () => {
  const view = sessionHook();
  const attempt = begin(view);
  const methods = view.result.current;
  view.unmount();
  expect(attempt.signal.aborted).toBe(true);
  const late = rawHandle();
  expect(methods.accept(attempt, late.handle)).toBe(false);
  expect(methods.accept(attempt, late.handle)).toBe(false);
  const stale = methods.begin();
  expect(stale.current()).toBe(false);
  expect(stale.signal.aborted).toBe(true);
  await waitFor(() =>
    expect(late.disconnect).toHaveBeenCalledExactlyOnceWith(
      late.handle.session,
    ),
  );
  expect(view.ended).not.toHaveBeenCalled();
  expect(locks.size).toBe(0);
});

it("replays StrictMode with a fresh usable caller and no unmount terminal callback", async () => {
  const attempts: SecretBackendSessionAttempt[] = [];
  const handles = [rawHandle(), rawHandle()];
  const ended = vi.fn();
  const view = renderHook(
    () => {
      const session = useSecretBackendSession(ended);
      useLayoutEffect(() => {
        const raw = handles[attempts.length];
        if (!raw) throw new Error("Missing replay fixture");
        const attempt = session.begin();
        attempts.push(attempt);
        expect(session.accept(attempt, raw.handle)).toBe(true);
      }, [session.begin, session.accept]);
      return session;
    },
    { reactStrictMode: true },
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.signal.aborted).toBe(true);
  expect(attempts[1]?.current()).toBe(true);
  expect(view.result.current.active).toBe(handles[1]?.handle);
  view.unmount();
  expect(attempts[1]?.signal.aborted).toBe(true);
  await waitFor(() => {
    for (const raw of handles) expect(raw.disconnect).toHaveBeenCalledOnce();
  });
  expect(ended).not.toHaveBeenCalled();
});

it("rejects subscription-time closure without leaving a second signal listener attached", async () => {
  const view = sessionHook();
  const raw = rawHandle();
  const add = raw.lifetime.signal.addEventListener.bind(raw.lifetime.signal);
  vi.spyOn(raw.lifetime.signal, "addEventListener").mockImplementation(
    (...args) => {
      add(...args);
      raw.lifetime.abort();
    },
  );
  const providerAdd = vi.spyOn(raw.provider.signal, "addEventListener");
  const attempt = begin(view);
  act(() =>
    expect(view.result.current.accept(attempt, raw.handle)).toBe(false),
  );
  expect(providerAdd).not.toHaveBeenCalled();
  expect(view.result.current.active).toBeNull();
  expect(view.ended).not.toHaveBeenCalled();
  await waitFor(() => expect(raw.disconnect).toHaveBeenCalledOnce());
});
