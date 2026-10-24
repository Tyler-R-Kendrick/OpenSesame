import {
  type HostEvent,
  NativeHTTPResponse,
  type NativeRequest,
} from "./protocol.js";
import type { NativePeerGETClient } from "./sdk-peer-get.js";
import type { BrowserNodeClient } from "./sdk.js";
type Port = NativePeerGETClient;
type Entry = {
  id: number;
  url: string;
  port: Port;
  read: Port["nativeHTTP"];
  ready: Port["ready"];
  cancel: Port["cancelHTTP"];
  caller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};
function peerGETURL(raw: string): URL | null {
  if (raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/** One original Worker node; no browser fetch or provider-HTTP policy relaxation. */
export class WorkerPeerGET {
  private ended = false;
  private high = 0;
  private pending = new Map<number, Entry>();
  private retirement: Promise<boolean> | null = null;
  private originalPeer: NativePeerGETClient | null = null;
  constructor(
    private readonly node: () => Pick<
      BrowserNodeClient,
      "nativePeerGET"
    > | null,
    private readonly post: (message: HostEvent) => void,
  ) {}
  get closed() {
    return this.ended;
  }
  private current(entry: Entry) {
    const node = this.node();
    const port = node?.nativePeerGET;
    return (
      !this.ended &&
      this.pending.get(entry.id) === entry &&
      !entry.caller.signal.aborted &&
      port === entry.port &&
      port.ready === entry.ready &&
      port.nativeHTTP === entry.read &&
      port.cancelHTTP === entry.cancel &&
      entry.ready.call(port)
    );
  }
  private retire(entry: Entry) {
    if (this.pending.get(entry.id) !== entry) return;
    this.pending.delete(entry.id);
    clearTimeout(entry.timer);
    entry.caller.abort();
  }
  private fail(entry: Entry) {
    if (this.pending.get(entry.id) !== entry) return;
    this.retire(entry);
    entry.cancel.call(entry.port, entry.id);
    this.post({ kind: "error" });
  }
  get(id: number, raw: string) {
    const url = peerGETURL(raw);
    if (
      this.ended ||
      !Number.isSafeInteger(id) ||
      id <= this.high ||
      id < 1 ||
      !url
    ) {
      this.post({ kind: "error" });
      return;
    }
    this.high = id;
    const node = this.node();
    const port = node?.nativePeerGET;
    if (
      !port ||
      (this.originalPeer && this.originalPeer !== port) ||
      this.pending.size >= 4
    ) {
      this.post({ kind: "error" });
      return;
    }
    this.originalPeer = port;
    const caller = new AbortController();
    const entry: Entry = {
      id,
      url: url.href,
      port,
      read: port.nativeHTTP,
      ready: port.ready,
      cancel: port.cancelHTTP,
      caller,
      timer: setTimeout(() => this.fail(entry), 30_000),
    };
    this.pending.set(id, entry);
    try {
      if (!this.current(entry)) throw new Error("Original peer node ended");
      const request: NativeRequest = {
        method: "GET",
        url: entry.url,
        headers: [],
        body: new Uint8Array(),
      };
      void entry.read
        .call(port, id, request, caller.signal)
        .then((response) => {
          const parsed = NativeHTTPResponse.safeParse(response);
          if (
            !parsed.success ||
            parsed.data.url !== entry.url ||
            (parsed.data.status >= 300 && parsed.data.status < 400) ||
            parsed.data.body.byteLength > 1_000_000 ||
            !this.current(entry)
          ) {
            this.fail(entry);
            return;
          }
          const body = parsed.data.body.slice();
          const text = new TextDecoder().decode(body);
          if (text.length > 1_000_000 || !this.current(entry)) {
            this.fail(entry);
            return;
          }
          this.retire(entry);
          this.post({ kind: "get", id, status: parsed.data.status, text });
        })
        .catch(() => this.fail(entry));
    } catch {
      this.fail(entry);
    }
  }
  withdraw(): void {
    this.ended = true;
    for (const entry of [...this.pending.values()]) {
      this.retire(entry);
      entry.cancel.call(entry.port, entry.id);
    }
  }
  close(): Promise<boolean> {
    if (this.retirement) return this.retirement;
    this.withdraw();
    const original = this.originalPeer ?? this.node()?.nativePeerGET;
    if (!original) return Promise.resolve(true);
    this.retirement = original.close().catch(() => false);
    return this.retirement;
  }
}
