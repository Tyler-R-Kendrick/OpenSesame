import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushActivityLog } from "../activity-log.js";
import { deviceConnection } from "../device-connectors.js";
import { kvFlush } from "../kv.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { createSecretBackend } from "./factory.js";
import { secretBackendDraft } from "./presets.js";
import {
  connectSecretBackend,
  saveSecretBackendConnection,
  secretBackendRuntimeSeams,
} from "./runtime.js";
import { deferred, runtimeFixture } from "./runtime.test-support.js";
import { secretBackendDeviceSeams as status } from "./seam.js";
import { secretBackendSessionClosure } from "./sessions.js";
import { readSecretBackendConnection } from "./store.js";
import type { SecretBackend } from "./types.js";

type Open = Awaited<ReturnType<typeof connectSecretBackend>>;
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let connectionId: string;
const handles: Open[] = [];
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];
const replies: (() => Response | Promise<Response>)[] = [];
const token = "private-runtime-issued-token";
const secret = "private-runtime-machine-secret";
const empty = () => Response.json({ secrets: [] });

async function flush() {
  await vaultStore.flushPendingWrites();
  await flushActivityLog();
  await vfsFlush();
  await kvFlush();
}
async function connect() {
  const open = await connectSecretBackend(connectionId);
  handles.push(open);
  return open;
}
function holdCleanup() {
  const gate = deferred<void>();
  releases.push(() => gate.resolve());
  const backends: SecretBackend[] = [];
  // Only disposal is delayed: factory, authentication, HTTP, codecs and fences stay real.
  vi.spyOn(secretBackendRuntimeSeams, "createBackend").mockImplementation(
    async (mode, check, signal) => {
      const backend = await createSecretBackend(mode, check, signal);
      const disconnect = backend.disconnect.bind(backend);
      vi.spyOn(backend, "disconnect").mockImplementation(async (session) => {
        await disconnect(session);
        await gate.promise;
      });
      backends.push(backend);
      return backend;
    },
  );
  return { gate, backends };
}
function observeWithdrawal(open: Open, backend: SecretBackend) {
  const revision = status.snapshot();
  const listener = vi.fn(() => {
    expect(status.snapshot()).toBe(revision + 1);
    expect(deviceConnection(connectionId)?.status).toBe("pending");
    expect(open.signal?.aborted).toBe(true);
    expect(backend.disconnect).not.toHaveBeenCalled();
  });
  const stop = status.subscribe(listener);
  releases.push(stop);
  return { revision, listener, stop };
}

beforeEach(async () => {
  fixture = await runtimeFixture();
  fixture.fetcher.mockImplementation(async (input, init) => {
    if (String(input).endsWith("/login")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        clientId: "runtime-machine",
        clientSecret: secret,
      });
      return Response.json({
        accessToken: token,
        expiresIn: 1,
        accessTokenMaxTTL: 100,
        tokenType: "Bearer",
      });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${token}`,
    );
    return replies.shift()?.() ?? empty();
  });
  const saved = await saveSecretBackendConnection({
    ...secretBackendDraft("infisical"),
    baseUrl: "https://infisical.example.test",
    projectId: "project",
    environment: "dev",
    secretPath: "/backup",
    clientId: "runtime-machine",
    clientSecret: secret,
  });
  connectionId = saved.connectionId;
  await flush();
  expect(readSecretBackendConnection(connectionId)?.clientSecret).toBe("");
  expect([...fixture.files.values()].join("")).not.toContain("private-");
  expect(fixture.fetcher).not.toHaveBeenCalled();
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(
    handles.splice(0).map((open) => open.backend.disconnect(open.session)),
  );
  await Promise.allSettled(pending.splice(0));
  replies.length = 0;
  vi.useRealTimers();
  await fixture.close();
});

it("withdraws idle issued-token admission before held cleanup without rewriting sealed configuration or refreshing", async () => {
  const cleanup = holdCleanup();
  const open = await connect();
  const backend = cleanup.backends[0];
  if (!backend) throw new Error("Expected real factory backend");
  expect(deviceConnection(connectionId)?.status).toBe("active");
  expect(open.signal).not.toBe(open.session.signal);
  expect(Object.isFrozen(open.session)).toBe(true);
  await flush();
  const files = [...fixture.files];
  const observed = observeWithdrawal(open, backend);
  const calls = fixture.fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(open.session.signal?.aborted).toBe(true);
  expect(secretBackendSessionClosure(open.session)).toBe("provider-ended");
  expect(observed.listener).toHaveBeenCalledOnce();
  expect(status.snapshot()).toBe(observed.revision + 1);
  expect(backend.disconnect).toHaveBeenCalledExactlyOnceWith(open.session);
  await expect(open.backend.listItems(open.session)).rejects.toMatchObject({
    code: "stale",
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fixture.fetcher).toHaveBeenCalledTimes(calls);
  await flush();
  expect([...fixture.files]).toEqual(files);
  observed.stop();
  const fresh = await connect();
  const revision = status.snapshot();
  expect(fresh.signal?.aborted).toBe(false);
  expect(deviceConnection(connectionId)?.status).toBe("active");
  cleanup.gate.resolve();
  await open.backend.disconnect(open.session);
  expect(fresh.signal?.aborted).toBe(false);
  expect(status.snapshot()).toBe(revision);
  expect(await fresh.backend.listItems(fresh.session)).toEqual([]);
});

it.each([401, 403])(
  "withdraws actual HTTP%s token failure and isolates late results/cleanup from reconnect",
  async (code) => {
    const cleanup = holdCleanup();
    const open = await connect();
    const backend = cleanup.backends[0];
    if (!backend) throw new Error("Expected actual factory backend");
    const late = deferred<Response>();
    releases.push(() => late.resolve(empty()));
    replies.push(() => late.promise);
    const operation = open.backend.listItems(open.session);
    const ended = expect(operation).rejects.toMatchObject({ code: "stale" });
    pending.push(ended);
    await vi.advanceTimersByTimeAsync(0);
    const signal = fixture.fetcher.mock.calls.at(-1)?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    const files = [...fixture.files];
    const observed = observeWithdrawal(open, backend);
    replies.push(() =>
      Response.json(
        {
          statusCode: code,
          error: "TokenError",
          message: secret,
        },
        { status: code },
      ),
    );
    await expect(open.backend.listItems(open.session)).rejects.toMatchObject({
      code: "stale",
    });
    await ended;
    expect(signal?.aborted).toBe(true);
    expect(open.session.signal?.aborted).toBe(true);
    expect(secretBackendSessionClosure(open.session)).toBe("provider-ended");
    expect(observed.listener).toHaveBeenCalledOnce();
    expect(status.snapshot()).toBe(observed.revision + 1);
    expect(backend.disconnect).toHaveBeenCalledExactlyOnceWith(open.session);
    const calls = fixture.fetcher.mock.calls.length;
    await expect(open.backend.listItems(open.session)).rejects.toMatchObject({
      code: "stale",
    });
    expect(fixture.fetcher).toHaveBeenCalledTimes(calls);
    await flush();
    expect([...fixture.files]).toEqual(files);
    observed.stop();
    const fresh = await connect();
    const revision = status.snapshot();
    late.resolve(
      Response.json({ error: "private-late-refusal" }, { status: 401 }),
    );
    cleanup.gate.resolve();
    await open.backend.disconnect(open.session);
    await vi.advanceTimersByTimeAsync(0);
    expect(deviceConnection(connectionId)?.status).toBe("active");
    expect(fresh.signal?.aborted).toBe(false);
    expect(status.snapshot()).toBe(revision);
    expect(await fresh.backend.listItems(fresh.session)).toEqual([]);
  },
);

it.each(["permission", "unknown403", "server", "network"])(
  "keeps actual %s failure admitted and allows another request",
  async (mode) => {
    const open = await connect();
    const revision = status.snapshot();
    const files = [...fixture.files];
    replies.push(() => {
      if (mode === "network") throw new Error(secret);
      return Response.json(
        {
          statusCode: mode === "server" ? 500 : 403,
          error: mode === "permission" ? "PermissionDenied" : "Unknown",
          message: secret,
        },
        { status: mode === "server" ? 500 : 403 },
      );
    });
    const failure = await open.backend
      .listItems(open.session)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject(
      mode === "network"
        ? { code: "network" }
        : { status: mode === "server" ? 500 : 403, responseKind: null },
    );
    expect(
      JSON.stringify(Object.getOwnPropertyDescriptors(failure)),
    ).not.toContain("private-");
    expect(open.signal?.aborted).toBe(false);
    expect(open.session.signal?.aborted).toBe(false);
    expect(secretBackendSessionClosure(open.session)).toBeNull();
    expect(deviceConnection(connectionId)?.status).toBe("active");
    expect(status.snapshot()).toBe(revision);
    expect(await open.backend.listItems(open.session)).toEqual([]);
    expect(
      fixture.fetcher.mock.calls.filter(([input]) =>
        String(input).endsWith("/login"),
      ),
    ).toHaveLength(1);
    await flush();
    expect([...fixture.files]).toEqual(files);
  },
);
