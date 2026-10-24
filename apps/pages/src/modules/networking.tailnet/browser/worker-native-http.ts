/** One original worker owns buffered and pull operations in the same registry. */
import {
  type HostEvent,
  NativeHTTPResponse,
  NativeHTTPStreamChunk,
  NativeHTTPStreamHead,
  type NativeRequest,
  type NativeResponse,
  type NativeStreamChunk,
  type NativeStreamHead,
  type WorkerMessage,
} from "./protocol.js";
import type { NativeHTTPClient } from "./sdk.js";

type NativeCommand = Extract<
  ReturnType<typeof WorkerMessage.parse>,
  {
    kind:
      | "nativeHTTPReady"
      | "nativeHTTP"
      | "nativeHTTPStream"
      | "pullHTTP"
      | "cancelHTTP"
      | "closeHTTP";
  }
>;
type Entry = {
  id: number;
  caller: AbortController;
  port: NativeHTTPClient;
  ready: NativeHTTPClient["ready"];
  buffered: NativeHTTPClient["nativeHTTP"];
  open: NativeHTTPClient["nativeHTTPStream"];
  pull: NativeHTTPClient["pullHTTP"];
  request: NativeRequest;
  stream: boolean;
  opened: boolean;
  pulling: boolean;
  next: number;
  bytes: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};
export class WorkerNativeHTTP {
  private high = 0;
  private ended = false;
  private pending = new Map<number, Entry>();
  constructor(
    private readonly port: () => NativeHTTPClient | undefined,
    private readonly post: (message: HostEvent) => void,
  ) {}
  get closed() {
    return this.ended;
  }
  private identity(entry: Entry) {
    const port = this.port();
    const now = performance.now();
    return (
      port === entry.port &&
      now < entry.deadline &&
      this.pending.get(entry.id) === entry &&
      !entry.caller.signal.aborted &&
      !this.ended
    );
  }
  private methodsCurrent(entry: Entry) {
    return (
      entry.port.ready === entry.ready &&
      entry.port.nativeHTTP === entry.buffered &&
      (!entry.stream ||
        (entry.port.nativeHTTPStream === entry.open &&
          entry.port.pullHTTP === entry.pull))
    );
  }
  private current(entry: Entry) {
    try {
      return (
        this.identity(entry) &&
        this.methodsCurrent(entry) &&
        entry.ready() &&
        this.methodsCurrent(entry) &&
        this.identity(entry)
      );
    } catch {
      return false;
    }
  }
  private cancelPort(port: NativeHTTPClient | undefined, id: number) {
    try {
      port?.cancelHTTP(id);
    } catch {
      // Promise withdrawal still wins; the original SDK owns socket settlement.
    }
  }
  private retire(entry: Entry) {
    if (this.pending.get(entry.id) !== entry) return;
    this.pending.delete(entry.id);
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  private cancel(id: number) {
    this.high = Math.max(this.high, id);
    const entry = this.pending.get(id);
    if (entry) this.retire(entry);
    entry?.caller.abort();
    this.cancelPort(entry?.port ?? this.port(), id);
  }
  private fail(entry: Entry) {
    if (this.pending.get(entry.id) !== entry) return;
    this.cancel(entry.id);
    this.post({ kind: "nativeHTTPError", id: entry.id });
  }
  close(): boolean {
    this.ended = true;
    for (const entry of [...this.pending.values()]) this.cancel(entry.id);
    return this.port()?.closeHTTP() ?? true;
  }
  private admit(id: number, request: NativeRequest, stream: boolean) {
    if (id <= this.high) {
      this.post({ kind: "nativeHTTPError", id });
      return;
    }
    this.high = id;
    const port = this.port();
    if (
      !port ||
      this.ended ||
      this.pending.size >= 4 ||
      (stream && (!port.nativeHTTPStream || !port.pullHTTP))
    ) {
      this.cancelPort(port, id);
      this.post({ kind: "nativeHTTPError", id });
      return;
    }
    const entry: Entry = {
      id,
      port,
      caller: new AbortController(),
      ready: port.ready,
      buffered: port.nativeHTTP,
      open: port.nativeHTTPStream,
      pull: port.pullHTTP,
      request: {
        ...request,
        body: request.body.slice(),
        headers: request.headers.map(([name, value]) => [name, value]),
      },
      stream,
      opened: false,
      pulling: false,
      next: 1,
      bytes: 0,
      deadline: performance.now() + 30_000,
      timer: undefined,
    };
    this.pending.set(id, entry);
    entry.timer = setTimeout(() => this.fail(entry), 30_000);
    if (!this.current(entry)) {
      this.fail(entry);
      return;
    }
    try {
      if (stream) {
        const opened = entry.open?.call(
          port,
          id,
          entry.request,
          entry.caller.signal,
        );
        if (!opened) throw new Error("Missing native stream callback.");
        void opened
          .then((head) => this.headers(entry, head))
          .catch(() => this.fail(entry));
      } else {
        void entry.buffered
          .call(port, id, entry.request, entry.caller.signal)
          .then((result) => this.buffered(entry, result))
          .catch(() => this.fail(entry));
      }
    } catch {
      this.fail(entry);
    }
  }
  private buffered(entry: Entry, result: NativeResponse) {
    if (this.pending.get(entry.id) !== entry) return;
    const parsed = NativeHTTPResponse.safeParse(result);
    if (
      !parsed.success ||
      parsed.data.url !== entry.request.url ||
      !this.current(entry)
    ) {
      this.fail(entry);
      return;
    }
    const value = { ...parsed.data, body: parsed.data.body.slice() };
    if (!this.current(entry)) {
      this.fail(entry);
      return;
    }
    this.retire(entry);
    this.post({ kind: "nativeHTTP", id: entry.id, result: value });
  }
  private headers(entry: Entry, result: NativeStreamHead) {
    if (this.pending.get(entry.id) !== entry) return;
    const parsed = NativeHTTPStreamHead.safeParse(result);
    if (
      !parsed.success ||
      parsed.data.url !== entry.request.url ||
      !this.current(entry)
    ) {
      this.fail(entry);
      return;
    }
    const value: NativeStreamHead = {
      ...parsed.data,
      headers: parsed.data.headers.map(([name, text]) => [name, text]),
    };
    if (!this.current(entry)) {
      this.fail(entry);
      return;
    }
    entry.opened = true;
    this.post({ kind: "nativeHTTPStream", id: entry.id, result: value });
  }
  private chunk(entry: Entry, sequence: number, result: NativeStreamChunk) {
    if (this.pending.get(entry.id) !== entry) return;
    const parsed = NativeHTTPStreamChunk.safeParse(result);
    if (
      !parsed.success ||
      parsed.data.sequence !== sequence ||
      !entry.pulling ||
      entry.next !== sequence ||
      entry.bytes + parsed.data.body.byteLength > 4_194_304 ||
      !this.current(entry)
    ) {
      this.fail(entry);
      return;
    }
    const value = { ...parsed.data, body: parsed.data.body.slice() };
    if (!this.current(entry)) {
      this.fail(entry);
      return;
    }
    entry.bytes += value.body.byteLength;
    entry.next++;
    if (value.eof) this.retire(entry);
    this.post({ kind: "nativeHTTPChunk", id: entry.id, result: value });
    if (this.pending.get(entry.id) === entry) entry.pulling = false;
  }
  private pull(id: number, sequence: number) {
    const entry = this.pending.get(id);
    if (!entry) {
      this.post({ kind: "nativeHTTPError", id });
      return;
    }
    if (
      !entry.stream ||
      !entry.opened ||
      entry.pulling ||
      sequence !== entry.next ||
      !this.current(entry)
    ) {
      this.fail(entry);
      return;
    }
    entry.pulling = true;
    try {
      const pulled = entry.pull?.call(entry.port, id, sequence);
      if (!pulled) throw new Error("Missing native pull callback.");
      void pulled
        .then((value) => this.chunk(entry, sequence, value))
        .catch(() => this.fail(entry));
    } catch {
      this.fail(entry);
    }
  }
  receive(
    message: ReturnType<typeof WorkerMessage.parse>,
  ): message is NativeCommand {
    if (message.kind === "nativeHTTPReady") {
      this.post({
        kind: "nativeHTTPReady",
        ready: !this.ended && this.port()?.ready() === true,
      });
    } else if (
      message.kind === "nativeHTTP" ||
      message.kind === "nativeHTTPStream"
    ) {
      this.admit(
        message.id,
        message.request,
        message.kind === "nativeHTTPStream",
      );
    } else if (message.kind === "pullHTTP") {
      this.pull(message.id, message.sequence);
    } else if (message.kind === "cancelHTTP") {
      this.cancel(message.id);
    } else if (message.kind === "closeHTTP") {
      this.post({ kind: "closeHTTP", closed: this.close() });
    } else return false;
    return true;
  }
}
