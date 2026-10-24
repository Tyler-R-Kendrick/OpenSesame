/** @vitest-environment node */
// Original BrowserNodeWorker wiring with only the existing SDK boundary doubled.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Configuration,
  type HostEvent,
  type NativeRequest,
  type NativeResponse,
  type WorkerMessage,
} from "./protocol.js";
import type { loadBrowserNode } from "./sdk.js";
import type { BrowserNodeWorker } from "./worker.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const config = Configuration.parse({
  hostname: "peer-worker",
  controlURL: "https://control.example",
  authKey: "",
  state: {},
  assets: {
    runtime: "https://app.example/runtime.js",
    wasm: "https://app.example/node.gz",
    nativeHTTP: "https://app.example/native.js",
  },
});
let held: Map<number, ReturnType<typeof deferred<NativeResponse>>>;
let sent: HostEvent[];
let driver: BrowserNodeWorker;
function createClient() {
  return {
    run: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    fetch: vi.fn(),
    nativeHTTP: {
      ready: () => true,
      nativeHTTP: vi.fn(),
      cancelHTTP: () => true,
      closeHTTP: () => true,
    },
    nativePeerGET: {
      ready: () => true,
      nativeHTTP: vi.fn(
        (id: number, _request: NativeRequest, _signal: AbortSignal) => {
          const gate = deferred<NativeResponse>();
          held.set(id, gate);
          return gate.promise;
        },
      ),
      cancelHTTP: () => true,
      close: async () => true,
    },
  };
}
let client: ReturnType<typeof createClient>;
let grants: MessageChannel;
const loader = vi.fn<typeof loadBrowserNode>();
const approved = "http://100.64.0.1:8080/proof";
function send(message: ReturnType<typeof WorkerMessage.parse>) {
  driver.command(new MessageEvent("message", { data: message }));
}
/** The controller's end of the port the original `start` transferred. */
function grant(id: number, url: string) {
  grants.port1.postMessage({ kind: "get", id, url });
}
const forget = () => new Promise((resolve) => setTimeout(resolve, 20));
function response(): NativeResponse {
  return {
    status: 200,
    statusText: "OK",
    url: "http://100.64.0.1:8080/proof",
    headers: [],
    body: new Uint8Array([65]),
  };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}
async function load() {
  const { BrowserNodeWorker } = await import("./worker.js");
  driver = new BrowserNodeWorker((message) => sent.push(message), {
    load: loader,
    egress: vi.fn(),
  });
  grants = new MessageChannel();
  driver.receive(
    new MessageEvent("message", {
      data: { kind: "start", config },
      ports: [grants.port2],
    }),
  );
  await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
}
beforeEach(() => {
  vi.resetModules();
  held = new Map();
  sent = [];
  client = createClient();
  loader.mockReset().mockResolvedValue(client);
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("postMessage", vi.fn());
});
afterEach(async () => {
  send({ kind: "closeHTTP" });
  await settle();
  grants.port1.close();
  vi.unstubAllGlobals();
});
it("refuses a peer GET posted on the Worker's own channel, which any holder of the Worker reaches", async () => {
  await load();
  driver.receive(
    new MessageEvent("message", {
      data: { kind: "get", id: 9, url: approved },
    }),
  );
  await forget();
  expect(client.nativePeerGET.nativeHTTP).not.toHaveBeenCalled();
  expect(client.nativeHTTP.nativeHTTP).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
  grant(1, approved);
  await vi.waitFor(() => expect(held.size).toBe(1));
  held.get(1)?.resolve(response());
  await vi.waitFor(() =>
    expect(sent).toEqual([{ kind: "get", id: 1, status: 200, text: "A" }]),
  );
  expect(client.nativePeerGET.nativeHTTP).toHaveBeenCalledTimes(1);
});

it("keeps the grant port the original start transferred", async () => {
  await load();
  const forged = new MessageChannel();
  driver.receive(
    new MessageEvent("message", {
      data: { kind: "start", config },
      ports: [forged.port2],
    }),
  );
  forged.port1.postMessage({ kind: "get", id: 2, url: approved });
  await forget();
  forged.port1.close();
  expect(client.nativePeerGET.nativeHTTP).not.toHaveBeenCalled();
  grant(1, approved);
  await vi.waitFor(() => expect(held.size).toBe(1));
  expect(client.nativePeerGET.nativeHTTP).toHaveBeenCalledTimes(1);
});

it("refuses a peer GET that redirects away from the approved URL", async () => {
  await load();
  grant(9, approved);
  await vi.waitFor(() => expect(held.size).toBe(1));
  [...held.values()][0].resolve({
    ...response(),
    url: "https://elsewhere.example/stolen",
  });
  await vi.waitFor(() => expect(sent).toContainEqual({ kind: "error" }));
  expect(sent).not.toContainEqual(expect.objectContaining({ kind: "get" }));
});

it("refuses a peer GET whose final URL differs from the approved URL", async () => {
  await load();
  grant(10, approved);
  await vi.waitFor(() => expect(held.size).toBe(1));
  [...held.values()][0].resolve({
    ...response(),
    url: "http://100.64.0.2:8080/proof",
  });
  await vi.waitFor(() => expect(sent).toContainEqual({ kind: "error" }));
  expect(sent).not.toContainEqual(expect.objectContaining({ kind: "get" }));
});

it("refuses a peer GET with credentials or a non-HTTP scheme before egress", async () => {
  await load();
  grant(11, "http://user:secret@100.64.0.1:8080/");
  grant(12, "file:///etc/passwd");
  await vi.waitFor(() =>
    expect(sent).toEqual([{ kind: "error" }, { kind: "error" }]),
  );
  expect(client.nativeHTTP.nativeHTTP).not.toHaveBeenCalled();
  expect(client.fetch).not.toHaveBeenCalled();
  expect(client.nativePeerGET.nativeHTTP).not.toHaveBeenCalled();
});
