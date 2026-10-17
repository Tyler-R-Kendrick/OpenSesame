/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import type { SecretBackendHandle } from "@opensesame/app-core/lib/secret-backends/runtime-admission.js";
import type { SecretBackend } from "@opensesame/app-core/lib/secret-backends/types.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { secretBackendDependencies as dependencies } from "./secret-backend-dependencies.js";
import { useSecretBackendConnection } from "./useSecretBackendConnection.js";

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
type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};
function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => {};
  let reject: Deferred<T>["reject"] = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function finish<T>(pending: Deferred<T>, value: T, failed = false) {
  await act(async () => {
    if (failed) pending.reject(new Error("Controlled request failed"));
    else pending.resolve(value);
  });
}
function rawHandle() {
  const admission = new AbortController();
  const provider = new AbortController();
  const session = Object.freeze({
    id: "same-public-id",
    backendId: "controlled",
    authenticatedAt: "",
    signal: provider.signal,
  });
  const disconnect = vi.fn<SecretBackend["disconnect"]>(async (provided) => {
    expect(provided).toBe(session);
  });
  const backend: SecretBackend = {
    id: "controlled",
    name: "Controlled caller fixture; no native authentication",
    capabilities: {
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
      import: false,
    },
    authenticate: vi.fn(),
    listItems: vi.fn(async () => []),
    getItem: vi.fn(),
    getNotes: vi.fn(),
    disconnect,
  };
  const handle: SecretBackendHandle = {
    backend,
    session,
    signal: admission.signal,
  };
  return { handle, admission, provider, disconnect };
}
function draw() {
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
  act(() => view.result.current.changed("mode", "file-import"));
  return { ...view, onFlash, onChanged };
}
beforeEach(() => {
  vi.spyOn(vaultStore, "onLock").mockImplementation(() => () => {});
  vi.spyOn(dependencies, "listSecretBackendConnections").mockReturnValue([]);
  vi.spyOn(dependencies, "readSecretBackendConnection").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("passes the live Probe action signal and clears current input on success", async () => {
  const response = deferred<void>();
  const probe = vi
    .spyOn(dependencies, "probeSecretBackend")
    .mockReturnValue(response.promise);
  const view = draw();
  act(() => view.result.current.setPassword("current-password"));
  act(() => view.result.current.probe());
  const [config, savedId, signal] = probe.mock.calls[0] ?? [];
  expect(config).toEqual(
    expect.objectContaining({ filePassword: "current-password" }),
  );
  expect(savedId).toBeUndefined();
  expect(signal?.aborted).toBe(false);
  await finish(response, undefined);
  expect(view.result.current.result).toBe("Secret backend connection verified");
  expect(view.result.current.password).toBe("");
  expect(view.result.current.busy).toBe(false);
  expect(signal?.aborted).toBe(true);
  expect(view.onChanged).not.toHaveBeenCalled();
});

it.each(["unmount", "clear", "draft"] as const)(
  "withdraws Probe on %s before a controlled late response",
  async (ending) => {
    const response = deferred<void>();
    const probe = vi
      .spyOn(dependencies, "probeSecretBackend")
      .mockReturnValue(response.promise);
    const view = draw();
    act(() => view.result.current.probe());
    const signal = probe.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);
    act(() => {
      if (ending === "unmount") view.unmount();
      else if (ending === "clear") view.result.current.clear();
      else view.result.current.changed("name", "Changed draft");
    });
    expect(signal?.aborted).toBe(true);
    await finish(response, undefined);
    if (ending !== "unmount") {
      expect(view.result.current.result).toBe("");
      expect(view.result.current.busy).toBe(false);
    }
    if (ending === "draft")
      expect(view.result.current.draft.name).toBe("Changed draft");
    expect(view.onFlash).not.toHaveBeenCalled();
    expect(view.onChanged).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "keeps successor Probe input when old failure=%s settles",
  async (failed) => {
    const first = deferred<void>();
    const second = deferred<void>();
    const probe = vi
      .spyOn(dependencies, "probeSecretBackend")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = draw();
    act(() => view.result.current.probe());
    act(() => view.result.current.changed("name", "Successor draft"));
    act(() => view.result.current.setPassword("successor-password"));
    act(() => view.result.current.probe());
    await finish(first, undefined, failed);
    expect(view.result.current.password).toBe("successor-password");
    expect(view.result.current.busy).toBe(true);
    expect(view.result.current.result).toBe("");
    expect(probe.mock.calls[1]?.[2]?.aborted).toBe(false);
    await finish(second, undefined);
    expect(view.result.current.password).toBe("");
    expect(view.result.current.result).toBe(
      "Secret backend connection verified",
    );
    expect(view.onFlash).not.toHaveBeenCalled();
  },
);

it("clears a current failed Probe password and keeps its draft retryable", async () => {
  const probe = vi
    .spyOn(dependencies, "probeSecretBackend")
    .mockRejectedValueOnce(new Error("Current Probe failed"))
    .mockResolvedValueOnce(undefined);
  const view = draw();
  act(() => view.result.current.changed("name", "Retry draft"));
  act(() => view.result.current.setPassword("failed-password"));
  act(() => view.result.current.probe());
  await waitFor(() =>
    expect(view.result.current.failure).toBe("Current Probe failed"),
  );
  expect(view.result.current.password).toBe("");
  expect(view.result.current.draft.name).toBe("Retry draft");
  expect(view.onFlash).toHaveBeenCalledOnce();
  act(() => view.result.current.probe());
  await waitFor(() =>
    expect(view.result.current.result).toBe(
      "Secret backend connection verified",
    ),
  );
  expect(probe).toHaveBeenCalledTimes(2);
});

it("clears accepted Connect input while retaining its dedicated caller", async () => {
  const raw = rawHandle();
  const connect = vi
    .spyOn(dependencies, "connectSecretBackend")
    .mockResolvedValue(raw.handle);
  const view = draw();
  act(() => view.result.current.setPassword("current-password"));
  act(() => view.result.current.connect());
  await waitFor(() => expect(view.result.current.active).toBe(raw.handle));
  expect(view.result.current.password).toBe("");
  expect(view.result.current.result).toBe("Secret backend session connected");
  expect(view.result.current.busy).toBe(false);
  expect(connect.mock.calls[0]?.[2]?.aborted).toBe(false);
  expect(raw.admission.signal.aborted).toBe(false);
  expect(raw.provider.signal.aborted).toBe(false);
  expect(raw.disconnect).not.toHaveBeenCalled();
});

it("clears a current failed Connect password before ending its attempt", async () => {
  const connect = vi
    .spyOn(dependencies, "connectSecretBackend")
    .mockRejectedValueOnce(new Error("Current Connect failed"));
  const view = draw();
  act(() => view.result.current.setPassword("failed-password"));
  act(() => view.result.current.connect());
  await waitFor(() =>
    expect(view.result.current.failure).toBe("Current Connect failed"),
  );
  expect(view.result.current.password).toBe("");
  expect(view.result.current.active).toBeNull();
  expect(connect.mock.calls[0]?.[2]?.aborted).toBe(true);
});

it.each([false, true])(
  "preserves successor Connect input on late failure=%s",
  async (failed) => {
    const first = deferred<SecretBackendHandle>();
    const second = deferred<SecretBackendHandle>();
    const old = rawHandle();
    const next = rawHandle();
    const connect = vi
      .spyOn(dependencies, "connectSecretBackend")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = draw();
    act(() => view.result.current.connect());
    act(() => view.result.current.clear());
    act(() => view.result.current.setPassword("successor-password"));
    act(() => view.result.current.connect());
    await finish(first, old.handle, failed);
    expect(view.result.current.password).toBe("successor-password");
    expect(view.result.current.busy).toBe(true);
    expect(view.result.current.active).toBeNull();
    expect(old.disconnect).toHaveBeenCalledTimes(failed ? 0 : 1);
    expect(connect.mock.calls[1]?.[2]?.aborted).toBe(false);
    await finish(second, next.handle);
    expect(view.result.current.active).toBe(next.handle);
    expect(view.result.current.password).toBe("");
    expect(view.result.current.result).toBe("Secret backend session connected");
    expect(view.onFlash).not.toHaveBeenCalled();
  },
);

it("clears old input before attempt-end abort can start a successor", async () => {
  const first = deferred<SecretBackendHandle>();
  const second = deferred<SecretBackendHandle>();
  const next = rawHandle();
  const connect = vi
    .spyOn(dependencies, "connectSecretBackend")
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const view = draw();
  act(() => view.result.current.setPassword("old-password"));
  act(() => view.result.current.connect());
  connect.mock.calls[0]?.[2]?.addEventListener(
    "abort",
    () => {
      view.result.current.clear();
      view.result.current.connect();
      view.result.current.setPassword("reentrant-password");
    },
    { once: true },
  );
  await finish(first, next.handle, true);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(view.result.current.password).toBe("reentrant-password");
  expect(view.result.current.busy).toBe(true);
  expect(view.result.current.failure).toBe("");
  expect(connect.mock.calls[1]?.[2]?.aborted).toBe(false);
  await finish(second, next.handle);
  expect(view.result.current.active).toBe(next.handle);
  expect(view.result.current.password).toBe("");
  expect(view.onFlash).not.toHaveBeenCalled();
});
