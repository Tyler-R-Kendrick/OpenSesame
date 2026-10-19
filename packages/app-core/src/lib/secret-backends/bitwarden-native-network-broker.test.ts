import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  NATIVE_LIMITS,
  NATIVE_PASSWORD,
  nativeHttpFixture,
} from "./bitwarden-native-http.test-support.js";
import { createBitwardenNativeNetworkBroker } from "./bitwarden-native-network-broker.js";
import {
  type NativeFetchReply,
  NativeFetchRequest,
} from "./bitwarden-native-network-protocol.js";
import { createBitwardenNativeWorkerFetch } from "./bitwarden-native-worker-fetch.js";
import type {
  NativeWorkerReply,
  NativeWorkerRequest,
} from "./bitwarden-native-worker-protocol.js";
import { createBitwardenNativeWorkerRuntime } from "./bitwarden-native-worker-runtime.js";
import type { SecretBackendTransport } from "./transport.js";

const closures: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closures.splice(0).reverse()) await close();
});
const ID = "00000000-0000-4000-8000-000000000001";
function request(
  url: string,
  method = "GET",
  headers = [["authorization", "Bearer owned-token"]],
  body = "",
) {
  return NativeFetchRequest.parse({
    type: "native-fetch",
    id: 1,
    url,
    method,
    headers,
    body,
  });
}
async function pipeline(modern: boolean) {
  const fixture = await nativeHttpFixture(modern);
  closures.push(fixture.close);
  const controller = new AbortController();
  const operations: RequestInit[] = [];
  const captured: SecretBackendTransport = {
    ...fixture.transport,
    signal: controller.signal,
    assertCurrent() {
      if (controller.signal.aborted)
        throw new Error("Captured activation ended");
    },
    fetch: async (input, init) => {
      operations.push(init ?? {});
      return fixture.transport.fetch(input, init);
    },
  };
  let closed!: () => void;
  const finished = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const replies: NativeWorkerReply[] = [];
  const waiting = new Map<number, (reply: NativeWorkerReply) => void>();
  const workerFetch = createBitwardenNativeWorkerFetch(
    (value) => broker.receive(value),
    controller.signal,
  );
  const broker = createBitwardenNativeNetworkBroker(
    {
      send: (reply) => workerFetch.receive(reply),
      fail: () => controller.abort(),
    },
    captured,
    fixture.credentials,
  );
  const worker = createBitwardenNativeWorkerRuntime(
    {
      send: (reply) => {
        replies.push(reply);
        waiting.get(reply.id)?.(reply);
        waiting.delete(reply.id);
      },
      close: () => {
        controller.abort();
        closed();
      },
    },
    {
      fetch: workerFetch.fetch,
      signal: controller.signal,
      assertCurrent: captured.assertCurrent,
    },
    NATIVE_LIMITS,
  );
  closures.push(async () => {
    controller.abort();
    workerFetch.close();
    broker.close();
    await worker.dispose();
  });
  const invoke = (value: NativeWorkerRequest) =>
    new Promise<NativeWorkerReply>((resolve) => {
      waiting.set(value.id, resolve);
      worker.receive(value);
    });
  const { email: accountEmail, ...credentials } = fixture.credentials;
  const initialize = () =>
    invoke({
      id: 1,
      type: "initialize",
      settings: {
        providerId: "bitwarden",
        name: "Native captured pipeline",
        ...credentials,
        accountEmail,
        masterPassword: NATIVE_PASSWORD,
        vaultId: "",
      },
    });
  return {
    fixture,
    finished,
    controller,
    operations,
    replies,
    invoke,
    initialize,
    workerFetch,
    broker,
  };
}
it.each([false, true])(
  "runs encrypted auth and full CRUD through worker network messages and captured real HTTP modern=%s",
  async (modern) => {
    const open = await pipeline(modern);
    expect(await open.initialize()).toEqual({ id: 1, ok: true, value: null });
    const item = {
      kind: "login" as const,
      name: "Captured encrypted login 🔐",
      notes: "Native RPC notes",
      secret: "native secret",
      username: "owned user",
      url: "https://owned.example/",
    };
    const created = await open.invoke({ id: 2, type: "create", item });
    expect(created).toMatchObject({ ok: true, value: item });
    if (!created.ok) throw new Error("Expected encrypted create.");
    const id = z.object({ id: z.string().uuid() }).parse(created.value).id;
    expect(await open.invoke({ id: 3, type: "get", selector: id })).toEqual({
      id: 3,
      ok: true,
      value: created.value,
    });
    expect(await open.invoke({ id: 4, type: "list" })).toMatchObject({
      ok: true,
      value: [{ id, name: item.name, kind: item.kind }],
    });
    expect(
      await open.invoke({
        id: 5,
        type: "update",
        itemId: id,
        item: { ...item, notes: "Updated over approved messages" },
      }),
    ).toMatchObject({
      ok: true,
      value: { id, notes: "Updated over approved messages" },
    });
    open.fixture.state.emptyTrash200 = true;
    expect(await open.invoke({ id: 6, type: "delete", itemId: id })).toEqual({
      id: 6,
      ok: true,
      value: null,
    });
    expect(await open.invoke({ id: 7, type: "list" })).toEqual({
      id: 7,
      ok: true,
      value: [],
    });
    expect(open.operations.length).toBeGreaterThan(10);
    for (const init of open.operations)
      expect(init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    for (const row of open.fixture.requests.filter((row) =>
      row.path.startsWith("/api/ciphers"),
    )) {
      expect(row.body).not.toContain(item.secret);
      expect(row.body).not.toContain(item.notes);
      expect(row.body).not.toContain(NATIVE_PASSWORD);
    }
  },
);
it("physically aborts the captured held request and publishes no late authenticated result", async () => {
  const open = await pipeline(false);
  const held = open.fixture.hold("/identity/connect/token", "POST");
  void open.initialize();
  await held.ready;
  const physical = open.operations.at(-1)?.signal;
  expect(physical?.aborted).toBe(false);
  open.controller.abort();
  expect(physical?.aborted).toBe(true);
  held.release();
  await open.finished;
  expect(open.replies.some((reply) => reply.id === 1 && reply.ok)).toBe(false);
  expect(
    open.fixture.requests.filter(
      (row) => row.path === "/identity/connect/token",
    ),
  ).toHaveLength(1);
});
function responseBroker(response: Response) {
  const controller = new AbortController();
  const replies: NativeFetchReply[] = [];
  let failed = 0;
  let resolve!: () => void;
  const completed = new Promise<void>((done) => {
    resolve = done;
  });
  const transport: SecretBackendTransport = {
    signal: controller.signal,
    assertCurrent() {
      if (controller.signal.aborted) throw new Error("Ended");
    },
    fetch: async () => response,
  };
  const broker = createBitwardenNativeNetworkBroker(
    {
      send(reply) {
        replies.push(reply);
        resolve();
      },
      fail() {
        failed++;
        resolve();
      },
    },
    transport,
    {
      baseUrl: "https://owned.example/api",
      identityUrl: "https://owned.example/identity",
    },
  );
  closures.push(broker.close);
  return { broker, replies, completed, failed: () => failed };
}
it("cancels oversized physical response readers and never forwards their private payload", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  const open = responseBroker(response);
  open.broker.receive(
    request(
      "https://owned.example/identity/accounts/prelogin",
      "POST",
      [["content-type", "application/json"]],
      "{}",
    ),
  );
  await open.completed;
  expect(cancelled).toBe(true);
  expect(open.replies).toEqual([
    { type: "native-fetch-reply", id: 1, ok: false },
  ]);
});
it("preserves received negative status while cancelling its body and rejects replay without network admission", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
    { status: 401 },
  );
  const open = responseBroker(response);
  const approved = request(`https://owned.example/api/ciphers/${ID}`);
  open.broker.receive(approved);
  await open.completed;
  expect(cancelled).toBe(true);
  expect(open.replies).toEqual([
    {
      type: "native-fetch-reply",
      id: 1,
      ok: true,
      status: 401,
      statusText: "",
      headers: [],
      body: new Uint8Array(),
    },
  ]);
  open.broker.receive(approved);
  expect(open.failed()).toBe(1);
});
it("refuses unapproved origins before dispatch and handles cancellation only for its exact ID", async () => {
  const open = responseBroker(
    new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  expect(open.broker.receive({ type: "native-fetch-cancel", id: 999 })).toBe(
    true,
  );
  expect(open.broker.receive({ unexpected: true })).toBe(false);
  expect(
    open.broker.receive(request(`https://other.example/api/ciphers/${ID}`)),
  ).toBe(true);
  expect(open.failed()).toBe(1);
  expect(open.replies).toEqual([]);
});
