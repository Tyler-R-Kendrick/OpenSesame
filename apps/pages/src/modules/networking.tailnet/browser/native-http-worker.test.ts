/** @vitest-environment node */
// SDK admission/ownership doubles only; actual Go/WASM HTTP is proved separately.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Configuration,
  type HostEvent,
  HostMessage,
  NativeHTTPRequest,
  type NativeRequest,
  type NativeResponse,
  WorkerMessage,
} from "./protocol.js";
import type { loadBrowserNode } from "./sdk.js";
import type { BrowserNodeWorker } from "./worker.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const config = Configuration.parse({
  hostname: "owned-worker",
  controlURL: "https://control.example",
  authKey: "",
  state: {},
  assets: {
    runtime: "https://app.example/runtime.js",
    wasm: "https://app.example/node.gz",
    nativeHTTP: "https://app.example/native.js",
  },
  nativeHTTP: {
    trustMode: "public",
    exitNodeID: "approved-exit",
    targets: [
      { origin: "https://provider.example", prefixes: ["203.0.113.0/24"] },
    ],
  },
});
function request(): NativeRequest {
  return {
    method: "POST",
    url: "https://provider.example/operation",
    headers: [["authorization", "private-fixture-token"]],
    body: new Uint8Array([0, 255, 1]),
  };
}
function response(): NativeResponse {
  return {
    status: 201,
    statusText: "Created",
    url: "https://provider.example/operation",
    headers: [["x-proof", "binary"]],
    body: new Uint8Array([0, 255, 1]),
  };
}
type Held = ReturnType<typeof deferred<NativeResponse>> & {
  signal: AbortSignal;
  request: NativeRequest;
};
let held: Map<number, Held>;
let sent: HostEvent[];
let driver: BrowserNodeWorker | null = null;
const loader = vi.fn<typeof loadBrowserNode>();
const egress = vi.fn();
function createClient() {
  return {
    run: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    fetch: vi.fn().mockRejectedValue(new Error("no peer HTTP double")),
    nativeHTTP: {
      ready: vi.fn(() => true),
      nativeHTTP: vi.fn(
        (id: number, input: NativeRequest, signal: AbortSignal) => {
          const gate = deferred<NativeResponse>();
          held.set(id, { ...gate, request: input, signal });
          return gate.promise;
        },
      ),
      cancelHTTP: vi.fn(() => true),
      closeHTTP: vi.fn(() => true),
    },
  };
}
let client: ReturnType<typeof createClient>;
let ports = new MessageChannel();
/** `start` carries the one port; every later command rides it. */
function send(data: ReturnType<typeof WorkerMessage.parse>) {
  if (!driver) throw new Error("Worker fixture not initialized.");
  if (data.kind === "start")
    driver.receive(new MessageEvent("message", { data, ports: [ports.port2] }));
  else driver.command(new MessageEvent("message", { data }));
}
async function load(start = true) {
  const { BrowserNodeWorker } = await import("./worker.js");
  driver = new BrowserNodeWorker((value) => sent.push(value), {
    load: loader,
    egress,
  });
  if (start) {
    send({ kind: "start", config });
    await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
  }
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  vi.resetModules();
  held = new Map();
  sent = [];
  driver = null;
  ports = new MessageChannel();
  client = createClient();
  loader.mockReset().mockResolvedValue(client);
  egress.mockReset();
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("postMessage", vi.fn());
});
afterEach(async () => {
  driver?.command(new MessageEvent("message", { data: { kind: "closeHTTP" } }));
  ports.port1.close();
  for (const gate of held.values()) gate.reject(new Error("owned teardown"));
  await settle();
  vi.unstubAllGlobals();
});
it("protocol bounds binary/header/status input and rejects mixed trust without promoting HTTP", () => {
  expect(WorkerMessage.safeParse({ kind: "start", config }).success).toBe(true);
  expect(
    WorkerMessage.safeParse({
      kind: "start",
      config: {
        ...config,
        nativeHTTP: { ...config.nativeHTTP, operatorCAPEM: "not-public" },
      },
    }).success,
  ).toBe(false);
  expect(
    NativeHTTPRequest.safeParse({
      ...request(),
      body: new Uint8Array(1_048_577),
    }).success,
  ).toBe(false);
  expect(
    NativeHTTPRequest.safeParse({
      ...request(),
      headers: [["x", "a".repeat(32769)]],
    }).success,
  ).toBe(false);
  for (const id of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1])
    expect(
      WorkerMessage.safeParse({ kind: "nativeHTTP", id, request: request() })
        .success,
    ).toBe(false);
  expect(
    HostMessage.safeParse({
      kind: "nativeHTTP",
      id: 1,
      result: { ...response(), body: new Uint8Array(4_194_305) },
    }).success,
  ).toBe(false);
  expect(
    HostMessage.safeParse({
      kind: "nativeHTTP",
      id: 1,
      result: { ...response(), status: 199 },
    }).success,
  ).toBe(false);
});
it("captures body/headers at synchronous admission and rejects a reused ID without cancelling its original", async () => {
  await load();
  const input = request();
  send({ kind: "nativeHTTP", id: 1, request: input });
  input.body[0] = 17;
  input.headers[0][1] = "changed";
  expect(held.get(1)?.request).toEqual({ ...request() });
  send({ kind: "nativeHTTP", id: 1, request: request() });
  expect(client.nativeHTTP.nativeHTTP).toHaveBeenCalledTimes(1);
  expect(held.get(1)?.signal.aborted).toBe(false);
  expect(client.nativeHTTP.cancelHTTP).not.toHaveBeenCalled();
  expect(sent).toContainEqual({ kind: "nativeHTTPError", id: 1 });
});
it("admits at most four pending operations and burns a rejected fifth ID", async () => {
  await load();
  for (let id = 1; id <= 5; id++)
    send({ kind: "nativeHTTP", id, request: request() });
  expect(client.nativeHTTP.nativeHTTP).toHaveBeenCalledTimes(4);
  expect(client.nativeHTTP.cancelHTTP).toHaveBeenCalledWith(5);
  held.get(1)?.resolve(response());
  await settle();
  send({ kind: "nativeHTTP", id: 5, request: request() });
  expect(client.nativeHTTP.nativeHTTP).toHaveBeenCalledTimes(4);
  send({ kind: "nativeHTTP", id: 6, request: request() });
  expect(client.nativeHTTP.nativeHTTP).toHaveBeenCalledTimes(5);
});
it("future cancellation consumes its ID before any request can start", async () => {
  await load();
  send({ kind: "cancelHTTP", id: 9 });
  for (const id of [8, 9]) send({ kind: "nativeHTTP", id, request: request() });
  expect(client.nativeHTTP.nativeHTTP).not.toHaveBeenCalled();
  send({ kind: "nativeHTTP", id: 10, request: request() });
  expect(held.has(10)).toBe(true);
});
it("cancelled A cannot publish while independent B can finish with snapshotted binary bytes", async () => {
  await load();
  send({ kind: "nativeHTTP", id: 1, request: request() });
  send({ kind: "nativeHTTP", id: 2, request: request() });
  send({ kind: "cancelHTTP", id: 1 });
  expect(held.get(1)?.signal.aborted).toBe(true);
  const value = response();
  held.get(2)?.resolve(value);
  await settle();
  value.body[0] = 22;
  value.headers[0][1] = "changed";
  expect(sent).toContainEqual({
    kind: "nativeHTTP",
    id: 2,
    result: response(),
  });
  held.get(1)?.resolve(response());
  await settle();
  expect(sent.some((item) => item.kind === "nativeHTTP" && item.id === 1)).toBe(
    false,
  );
  expect(client.logout).not.toHaveBeenCalled();
});
it("native close aborts originals, cannot revive them, and leaves ordinary node callbacks intact", async () => {
  await load();
  send({ kind: "nativeHTTP", id: 1, request: request() });
  send({ kind: "closeHTTP" });
  expect(held.get(1)?.signal.aborted).toBe(true);
  expect(client.nativeHTTP.closeHTTP).toHaveBeenCalledTimes(1);
  held.get(1)?.resolve(response());
  await settle();
  send({ kind: "nativeHTTP", id: 2, request: request() });
  send({ kind: "login" });
  expect(client.nativeHTTP.nativeHTTP).toHaveBeenCalledTimes(1);
  expect(client.login).toHaveBeenCalledTimes(1);
  expect(client.logout).not.toHaveBeenCalled();
  expect(sent).toContainEqual({ kind: "closeHTTP", closed: true });
  expect(sent).not.toContainEqual({
    kind: "nativeHTTP",
    id: 1,
    result: response(),
  });
});
it("failure and malformed result have fixed correlated errors without provider details", async () => {
  await load();
  send({ kind: "nativeHTTP", id: 1, request: request() });
  held.get(1)?.reject(new Error("private-fixture-token"));
  await settle();
  send({ kind: "nativeHTTP", id: 2, request: request() });
  held.get(2)?.resolve({ ...response(), status: 999 });
  await settle();
  expect(sent).toEqual([
    { kind: "nativeHTTPError", id: 1 },
    { kind: "nativeHTTPError", id: 2 },
  ]);
  expect(JSON.stringify(sent)).not.toContain("private-fixture-token");
});
it("close during asynchronous SDK startup retires native binding before ordinary run", async () => {
  const gate = deferred<typeof client>();
  loader.mockReturnValue(gate.promise);
  await load(false);
  send({ kind: "start", config });
  send({ kind: "closeHTTP" });
  gate.resolve(client);
  await vi.waitFor(() =>
    expect(sent).toContainEqual({ kind: "closeHTTP", closed: true }),
  );
  expect(client.run).not.toHaveBeenCalled();
  expect(client.nativeHTTP.closeHTTP).toHaveBeenCalledTimes(1);
  send({ kind: "nativeHTTP", id: 1, request: request() });
  expect(client.nativeHTTP.nativeHTTP).not.toHaveBeenCalled();
});

it("invalid boundary messages never admit work and a synchronous SDK failure is correlated", async () => {
  await load();
  driver?.command(
    new MessageEvent("message", {
      data: {
        kind: "nativeHTTP",
        id: 1,
        request: { ...request(), body: new Uint8Array(1048577) },
      },
    }),
  );
  expect(client.nativeHTTP.nativeHTTP).not.toHaveBeenCalled();
  client.nativeHTTP.nativeHTTP.mockImplementationOnce(() => {
    throw new Error("private-fixture-token");
  });
  send({ kind: "nativeHTTP", id: 2, request: request() });
  expect(sent).toEqual([{ kind: "nativeHTTPError", id: 2 }]);
});
it("readiness follows the captured binding and failed close is never reported acknowledged", async () => {
  await load();
  send({ kind: "nativeHTTPReady" });
  expect(sent).toContainEqual({ kind: "nativeHTTPReady", ready: true });
  client.nativeHTTP.closeHTTP.mockReturnValue(false);
  send({ kind: "closeHTTP" });
  send({ kind: "nativeHTTPReady" });
  expect(sent.at(-1)).toEqual({ kind: "nativeHTTPReady", ready: false });
  await vi.waitFor(() =>
    expect(sent).toContainEqual({ kind: "closeHTTP", closed: false }),
  );
  send({ kind: "nativeHTTPReady" });
  expect(sent.at(-1)).toEqual({ kind: "nativeHTTPReady", ready: false });
});

it("operator mode omission retains the actual Go configuration default", () => {
  const selected = Configuration.parse({
    ...config,
    nativeHTTP: {
      exitNodeID: "approved-exit",
      operatorCAPEM: "owned fixture PEM",
      targets: config.nativeHTTP?.targets,
    },
  });
  expect(selected.nativeHTTP?.trustMode).toBe("operator");
});

it("a resolved SDK result cannot publish after captured readiness withdrawal", async () => {
  await load();
  send({ kind: "nativeHTTP", id: 1, request: request() });
  held.get(1)?.resolve(response());
  client.nativeHTTP.ready.mockReturnValue(false);
  await settle();
  expect(sent).toEqual([{ kind: "nativeHTTPError", id: 1 }]);
});
it("final synchronous readiness reentrancy cannot publish a cancelled original entry", async () => {
  await load();
  send({ kind: "nativeHTTP", id: 1, request: request() });
  client.nativeHTTP.ready.mockImplementationOnce(() => {
    send({ kind: "cancelHTTP", id: 1 });
    return true;
  });
  held.get(1)?.resolve(response());
  await settle();
  expect(held.get(1)?.signal.aborted).toBe(true);
  expect(sent.some((item) => item.kind === "nativeHTTP")).toBe(false);
});
it("a successor requester on the same client cannot receive the original completion", async () => {
  await load();
  send({ kind: "nativeHTTP", id: 1, request: request() });
  client.nativeHTTP = { ...client.nativeHTTP, ready: vi.fn(() => true) };
  held.get(1)?.resolve(response());
  await settle();
  expect(sent).toEqual([{ kind: "nativeHTTPError", id: 1 }]);
});

it("a completed response for a different URL cannot satisfy the captured request", async () => {
  await load();
  send({ kind: "nativeHTTP", id: 1, request: request() });
  held.get(1)?.resolve({
    ...response(),
    url: "https://provider.example/foreign-operation",
  });
  await settle();
  expect(sent).toEqual([{ kind: "nativeHTTPError", id: 1 }]);
});

it("a peer configuration without an original Go port cannot become ready or send credentials", async () => {
  await load(false);
  loader.mockResolvedValueOnce({ ...client, nativeHTTP: undefined });
  const peer = Configuration.parse({
    ...config,
    nativeHTTP: {
      routeMode: "peer",
      peerID: "n-approved-peer",
      trustMode: "public",
      targets: [
        { origin: "https://provider.example", prefixes: ["100.64.0.1/32"] },
      ],
    },
  });
  send({ kind: "start", config: peer });
  await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
  send({ kind: "nativeHTTPReady" });
  expect(sent).toContainEqual({ kind: "nativeHTTPReady", ready: false });
  send({ kind: "nativeHTTP", id: 51, request: request() });
  await settle();
  expect(sent).toContainEqual({ kind: "nativeHTTPError", id: 51 });
  expect(client.nativeHTTP.nativeHTTP).not.toHaveBeenCalled();
  expect(client.fetch).not.toHaveBeenCalled();
});
