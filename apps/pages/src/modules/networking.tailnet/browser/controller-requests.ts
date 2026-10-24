import type { TailscaleHTTPRouteConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-peer-http.js";
import type {
  TailscaleNativeHTTPPort,
  TailscaleNodeConfiguration,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { anySignal } from "../../signals.js";
import {
  NativeStreamRequest,
  nativeStreamChannel,
  wantsNativeStream,
} from "./controller-native-stream.js";
import {
  Configuration,
  type HostEvent,
  NativeHTTPRequest,
} from "./protocol.js";
import type { BrowserNodeAssets } from "./sdk.js";

type Pending = {
  complete(message: HostEvent): void;
  fail(): void;
};
/** One original worker, node session and saved route/trust grant. Never ambient fetch. */
export class BrowserNodeRequests {
  #lifetime = new AbortController();
  #next = 0;
  #pending = new Map<number, Pending>();
  #readiness = new Set<(ready: boolean) => void>();
  private peerUsed = false;
  get usedPeer() {
    return this.peerUsed;
  }
  private retirement: Promise<boolean> | null = null;
  private retired: ((closed: boolean) => void) | null = null;
  // Truly private: nothing outside this object reaches the port, the pending
  // entries or a sender over the port; each stream holds only its own commands.
  readonly #port: Pick<MessagePort, "postMessage">;
  readonly #approvePeer: (url: string) => boolean;
  constructor(
    port: Pick<MessagePort, "postMessage">,
    private readonly check: () => void,
    private readonly connected: () => boolean,
    approvePeer: (url: string) => boolean,
    private readonly stop: () => void,
    private readonly nativeEnabled: boolean,
  ) {
    this.#port = port;
    this.#approvePeer = approvePeer;
  }
  private assertCurrent = () => {
    this.#lifetime.signal.throwIfAborted();
    this.check();
    if (!this.connected())
      throw new Error("Connect the original browser node first.");
  };
  receive(message: HostEvent): boolean {
    if (message.kind === "closeHTTP") {
      this.retired?.(message.closed);
      this.retired = null;
      return true;
    }
    if (message.kind === "nativeHTTPReady") {
      for (const resolve of [...this.#readiness]) resolve(message.ready);
      return true;
    }
    if (
      message.kind !== "nativeHTTP" &&
      message.kind !== "nativeHTTPError" &&
      message.kind !== "nativeHTTPStream" &&
      message.kind !== "nativeHTTPChunk" &&
      message.kind !== "get"
    )
      return false;
    this.#pending.get(message.id)?.complete(message);
    return true;
  }
  close(): Promise<boolean> {
    if (this.retirement) return this.retirement;
    this.retirement = new Promise<boolean>((resolve) => {
      this.retired = resolve;
    });
    this.#lifetime.abort();
    for (const pending of [...this.#pending.values()]) pending.fail();
    this.#pending.clear();
    for (const resolve of [...this.#readiness]) resolve(false);
    this.#readiness.clear();
    try {
      this.#port.postMessage({ kind: "closeHTTP" });
    } catch {
      this.retired?.(false);
      this.retired = null;
    }
    return this.retirement;
  }
  get(url: string): Promise<{ status: number; text: string }> {
    this.#lifetime.signal.throwIfAborted();
    this.check();
    if (this.#pending.size >= 4 || !this.connected() || !this.#approvePeer(url))
      return Promise.reject(
        new Error(
          "Connect a browser node and allow this tailnet service first.",
        ),
      );
    this.peerUsed = true;
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
      };
      const timer = setTimeout(() => {
        finish();
        this.stop();
        reject(
          new Error(
            "Tailscale peer request timed out; the browser node was disconnected.",
          ),
        );
      }, 30_000);
      this.#pending.set(id, {
        fail: () => {
          finish();
          reject(new Error("Tailscale node stopped."));
        },
        complete: (message) => {
          if (message.kind !== "get") return;
          finish();
          try {
            this.assertCurrent();
            if (!this.#approvePeer(url))
              throw new Error("The original peer grant ended.");
            resolve({ status: message.status, text: message.text });
          } catch {
            reject(new Error("The original Tailscale node changed."));
          }
        },
      });
      this.#port.postMessage({ kind: "get", id, url });
    });
  }
  capture(owner: AbortSignal): TailscaleNativeHTTPPort {
    this.assertCurrent();
    owner.throwIfAborted();
    if (!this.nativeEnabled)
      throw new Error(
        "Configure native HTTPS routing and trust for this browser node.",
      );
    const signal = anySignal([this.#lifetime.signal, owner]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      this.assertCurrent();
    };
    return Object.freeze({
      signal,
      assertCurrent,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        assertCurrent();
        const request = new Request(input, init);
        const caller = anySignal([
          signal,
          request.signal,
          AbortSignal.timeout(30_000),
        ]);
        caller.throwIfAborted();
        if (
          request.credentials === "include" ||
          request.integrity ||
          request.keepalive
        )
          throw new Error(
            "Native HTTPS uses explicit headers, without browser cookies, integrity or keepalive.",
          );
        const body = await readBody(request, caller);
        assertCurrent();
        caller.throwIfAborted();
        const value = NativeHTTPRequest.parse({
          method: request.method,
          url: request.url,
          headers: [...request.headers],
          body,
        });
        await this.#ready(caller);
        assertCurrent();
        caller.throwIfAborted();
        return wantsNativeStream(request)
          ? this.#stream(value, caller, assertCurrent)
          : this.#request(value, caller, assertCurrent);
      },
    });
  }
  #ready(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (ready: boolean) => {
        signal.removeEventListener("abort", abort);
        this.#readiness.delete(finish);
        if (ready && !signal.aborted) resolve();
        else
          reject(
            new Error(
              "Native HTTPS is not ready on the original browser node.",
            ),
          );
      };
      const abort = () => finish(false);
      this.#readiness.add(finish);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) finish(false);
      else this.#port.postMessage({ kind: "nativeHTTPReady" });
    });
  }
  #stream(
    request: ReturnType<typeof NativeHTTPRequest.parse>,
    signal: AbortSignal,
    check: () => void,
  ): Promise<Response> {
    check();
    signal.throwIfAborted();
    if (this.#pending.size >= 4)
      return Promise.reject(
        new Error("Native HTTPS request capacity reached."),
      );
    const id = ++this.#next;
    const stream = new NativeStreamRequest({
      request,
      signal,
      check,
      channel: nativeStreamChannel(this.#port, id, request),
      retire: () => this.#pending.delete(id),
    });
    this.#pending.set(id, stream);
    stream.start();
    return stream.response;
  }
  #request(
    request: ReturnType<typeof NativeHTTPRequest.parse>,
    signal: AbortSignal,
    check: () => void,
  ): Promise<Response> {
    check();
    signal.throwIfAborted();
    if (this.#pending.size >= 4)
      return Promise.reject(
        new Error("Native HTTPS request capacity reached."),
      );
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        this.#pending.delete(id);
      };
      const abort = () => {
        finish();
        this.#port.postMessage({ kind: "cancelHTTP", id });
        reject(new Error("The original native HTTPS request ended."));
      };
      this.#pending.set(id, {
        fail: abort,
        complete: (message) => {
          if (message.kind === "get") return;
          finish();
          try {
            check();
            signal.throwIfAborted();
            if (
              message.kind !== "nativeHTTP" ||
              message.result.url !== request.url
            )
              throw new Error(
                "Native HTTPS failed on the original browser node.",
              );
            const result = message.result;
            const empty =
              request.method === "HEAD" ||
              [204, 205, 304].includes(result.status);
            if (empty && result.body.length)
              throw new Error("Unexpected native HTTPS response body.");
            const response = new Response(
              empty ? null : result.body.slice().buffer,
              {
                status: result.status,
                statusText: result.statusText,
                headers: result.headers,
              },
            );
            Object.defineProperty(response, "url", { value: result.url });
            check();
            signal.throwIfAborted();
            resolve(response);
          } catch {
            reject(
              new Error("Native HTTPS failed on the original browser node."),
            );
          }
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else this.#port.postMessage({ kind: "nativeHTTP", id, request });
    });
  }
}
async function readBody(
  request: Request,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const value = await reader.read();
      signal.throwIfAborted();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > 1_048_576)
        throw new Error("Native HTTPS request body exceeds its limit.");
      chunks.push(value.value.slice());
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return body;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function nativeWorkerOptions(
  native: TailscaleHTTPRouteConfiguration | undefined,
  assets: { nativeHTTP?: BoundaryValue },
  base: URL,
) {
  const asset = assets.nativeHTTP;
  if (native && !isString(asset))
    throw new Error("This deployment is missing its native HTTPS asset.");
  const route = native
    ? {
        ...(native.version === 2
          ? { routeMode: native.routeMode, peerID: native.peerID }
          : { exitNodeID: native.exitNodeID }),
        targets: native.targets,
        trustMode: native.trustMode,
      }
    : undefined;
  return {
    nativeHTTP:
      native?.trustMode === "operator"
        ? { ...route, operatorCAPEM: native.operatorCAPEM }
        : route,
    asset: isString(asset) ? { nativeHTTP: new URL(asset, base).href } : {},
  };
}

export function browserNodeStartConfiguration(
  input: TailscaleNodeConfiguration,
  control: URL,
  assets: Pick<BrowserNodeAssets, "runtime" | "wasm">,
  base: URL,
) {
  return Configuration.parse({
    ...input,
    nativeHTTP: undefined,
    controlURL: control.origin,
    authKey: input.authKey ?? "",
    state: {},
    assets: {
      runtime: new URL(assets.runtime, base).href,
      wasm: new URL(assets.wasm, base).href,
    },
  });
}
