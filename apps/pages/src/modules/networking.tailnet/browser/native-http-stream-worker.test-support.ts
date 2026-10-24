/** SDK boundary fixture only; no Go, TLS, physical drain or browser proof. */
import { vi } from "vitest";
import {
  Configuration,
  type HostEvent,
  type NativeRequest,
  type NativeResponse,
  type NativeStreamChunk,
  type NativeStreamHead,
  type WorkerMessage,
} from "./protocol.js";
import type { NativeHTTPClient } from "./sdk.js";

export function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error("Missing deferred resolver");
      resolve(value);
    },
    reject(error: Error) {
      if (!reject) throw new Error("Missing deferred rejecter");
      reject(error);
    },
  };
}
export const request = (): NativeRequest => ({
  method: "GET",
  url: "https://provider.example/sse",
  headers: [["accept", "text/event-stream"]],
  body: new Uint8Array(),
});
export const head = (): NativeStreamHead => ({
  status: 200,
  statusText: "OK",
  url: request().url,
  headers: [["content-type", "text/event-stream"]],
});
export const chunk = (sequence = 1): NativeStreamChunk => ({
  sequence,
  body: new Uint8Array([0, 255, 1]),
  eof: false,
});
export const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
type Held<T> = ReturnType<typeof deferred<T>> & {
  request: NativeRequest;
  signal: AbortSignal;
};
function configuration() {
  return Configuration.parse({
    hostname: "original-stream-worker",
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
}

export async function fixture() {
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("postMessage", vi.fn());
  const sent: HostEvent[] = [];
  const opened = new Map<number, Held<NativeStreamHead>>();
  const buffered = new Map<number, Held<NativeResponse>>();
  const credits: {
    id: number;
    sequence: number;
    gate: ReturnType<typeof deferred<NativeStreamChunk>>;
  }[] = [];
  const port = {
    ready: vi.fn(() => true),
    nativeHTTP: vi.fn(
      (id: number, input: NativeRequest, signal: AbortSignal) => {
        const gate = deferred<NativeResponse>();
        buffered.set(id, { ...gate, request: input, signal });
        return gate.promise;
      },
    ),
    nativeHTTPStream: vi.fn(
      (id: number, input: NativeRequest, signal: AbortSignal) => {
        const gate = deferred<NativeStreamHead>();
        opened.set(id, { ...gate, request: input, signal });
        return gate.promise;
      },
    ),
    pullHTTP: vi.fn((id: number, sequence: number) => {
      const gate = deferred<NativeStreamChunk>();
      credits.push({ id, sequence, gate });
      return gate.promise;
    }),
    cancelHTTP: vi.fn(() => true),
    closeHTTP: vi.fn(() => true),
  };
  let native: NativeHTTPClient | undefined = port;
  const client = {
    run: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    fetch: vi.fn().mockRejectedValue(new Error("No peer fixture response")),
    get nativeHTTP() {
      return native;
    },
    set nativeHTTP(value: NativeHTTPClient | undefined) {
      native = value;
    },
  };
  const { BrowserNodeWorker } = await import("./worker.js");
  const worker = new BrowserNodeWorker((message) => sent.push(message), {
    load: vi.fn().mockResolvedValue(client),
    egress: vi.fn(),
  });
  // `start` carries the one port; every later command rides it.
  const ports = new MessageChannel();
  const send = (data: ReturnType<typeof WorkerMessage.parse>) => {
    if (data.kind === "start")
      worker.receive(
        new MessageEvent("message", { data, ports: [ports.port2] }),
      );
    else worker.command(new MessageEvent("message", { data }));
  };

  send({ kind: "start", config: configuration() });
  await settle();
  return {
    sent,
    opened,
    buffered,
    credits,
    port,
    client,
    worker,
    send,
    stream(id = 1) {
      send({ kind: "nativeHTTPStream", id, request: request() });
    },
    async headers(id = 1, value = head()) {
      const gate = opened.get(id);
      if (!gate) throw new Error("Missing original stream admission");
      gate.resolve(value);
      await settle();
    },
    async frame(id = 1, value = chunk()) {
      const credit = credits.filter((item) => item.id === id).at(-1);
      if (!credit) throw new Error("Missing original pull credit");
      credit.gate.resolve(value);
      await settle();
    },
    close() {
      send({ kind: "closeHTTP" });
      ports.port1.close();
      for (const gate of [...opened.values(), ...buffered.values()])
        gate.reject(new Error("Owned fixture teardown"));
      for (const item of credits)
        item.gate.reject(new Error("Owned fixture teardown"));
    },
  };
}
