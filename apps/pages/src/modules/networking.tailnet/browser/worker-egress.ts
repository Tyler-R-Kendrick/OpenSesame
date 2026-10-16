/** Install only inside the disposable SDK Worker, before instantiating Go. */
export type WorkerDecision = (url: string, method: string) => Promise<boolean>;
export function installWorkerEgress(
  decide: WorkerDecision,
  assets: readonly string[],
): void {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const NativeSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, "fetch", {
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (assets.includes(url.href))
        return nativeFetch(request, { redirect: "error", credentials: "omit" });
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !(await decide(url.href, request.method))
      )
        throw new Error("Tailscale HTTP destination denied.");
      return nativeFetch(request, { redirect: "error", credentials: "omit" });
    },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    value: approvedSocketClass(NativeSocket, decide),
  });
}
class ApprovedSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private socket: WebSocket | null = null;
  private closed = false;
  private binary: BinaryType = "blob";
  constructor(
    url: string | URL,
    protocols: string | string[] | undefined,
    Native: typeof WebSocket,
    decide: WorkerDecision,
  ) {
    super();
    this.url = new URL(url).href;
    void this.open(Native, protocols, decide);
  }
  get readyState() {
    return this.closed ? 3 : (this.socket?.readyState ?? 0);
  }
  get bufferedAmount() {
    return this.socket?.bufferedAmount ?? 0;
  }
  get protocol() {
    return this.socket?.protocol ?? "";
  }
  get extensions() {
    return this.socket?.extensions ?? "";
  }
  get binaryType() {
    return this.binary;
  }
  set binaryType(value: BinaryType) {
    this.binary = value;
    if (this.socket) this.socket.binaryType = value;
  }
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (!this.socket || this.closed)
      throw new Error("Tailscale socket is not open.");
    this.socket.send(value);
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.socket?.close(code, reason);
  }
  private async open(
    Native: typeof WebSocket,
    protocols: string | string[] | undefined,
    decide: WorkerDecision,
  ) {
    try {
      const url = new URL(this.url);
      if (
        !["wss:", "ws:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !(await decide(url.href, "CONNECT"))
      )
        throw new Error("Tailscale socket destination denied.");
      if (this.closed) return;
      this.socket = new Native(this.url, protocols);
      this.socket.binaryType = this.binary;
      this.socket.addEventListener("open", () => {
        const forwarded = new Event("open");
        this.dispatchEvent(forwarded);
        this.onopen?.(forwarded);
      });
      this.socket.addEventListener("error", () => {
        const forwarded = new Event("error");
        this.dispatchEvent(forwarded);
        this.onerror?.(forwarded);
      });
      this.socket.addEventListener("message", (event) => {
        const forwarded = new MessageEvent("message", {
          data: event.data,
          origin: event.origin,
          lastEventId: event.lastEventId,
        });
        this.dispatchEvent(forwarded);
        this.onmessage?.(forwarded);
      });
      this.socket.addEventListener("close", (event) => {
        this.closed = true;
        const forwarded = new CloseEvent("close", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        this.dispatchEvent(forwarded);
        this.onclose?.(forwarded);
      });
    } catch {
      this.closed = true;
      const error = new Event("error");
      this.dispatchEvent(error);
      this.onerror?.(error);
      const close = new CloseEvent("close", {
        code: 1008,
        reason: "Destination denied",
      });
      this.dispatchEvent(close);
      this.onclose?.(close);
    }
  }
}
function approvedSocketClass(Native: typeof WebSocket, decide: WorkerDecision) {
  return class extends ApprovedSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, Native, decide);
    }
  };
}
