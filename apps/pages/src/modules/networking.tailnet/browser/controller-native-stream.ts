import {
  type HostEvent,
  NativeHTTPStreamChunk,
  NativeHTTPStreamHead,
  type NativeRequest,
  type WorkerMessage,
} from "./protocol.js";

type Options = {
  id: number;
  request: NativeRequest;
  signal: AbortSignal;
  check(): void;
  post(message: ReturnType<typeof WorkerMessage.parse>): void;
  retire(): void;
};
/** One header-first response retains its original registry entry and caller. */
export class NativeStreamRequest {
  readonly response: Promise<Response>;
  private resolve: (response: Response) => void = () => {};
  private reject: (error: Error) => void = () => {};
  private body: ReadableStreamDefaultController<Uint8Array> | undefined;
  private credit: (() => void) | undefined;
  private opened = false;
  private ended = false;
  private next = 1;
  private bytes = 0;
  constructor(private readonly options: Options) {
    this.response = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
  private current() {
    this.options.check();
    this.options.signal.throwIfAborted();
    if (this.ended) throw new Error("Native stream ended.");
  }
  start() {
    this.options.signal.addEventListener("abort", this.fail, { once: true });
    try {
      this.current();
      this.options.post({
        kind: "nativeHTTPStream",
        id: this.options.id,
        request: this.options.request,
      });
    } catch {
      this.fail();
    }
  }
  private finish() {
    this.ended = true;
    this.options.signal.removeEventListener("abort", this.fail);
    this.options.retire();
    this.credit?.();
    this.credit = undefined;
  }
  private cancel() {
    try {
      this.options.post({ kind: "cancelHTTP", id: this.options.id });
    } catch {
      // An already terminated Worker cannot prevent local withdrawal.
    }
  }
  fail = () => {
    if (this.ended) return;
    this.finish();
    this.cancel();
    const error = new Error(
      "Native HTTPS failed on the original browser node.",
    );
    this.body?.error(error);
    this.reject(error);
  };
  private pull() {
    try {
      this.current();
      if (this.credit) throw new Error("Concurrent native stream credit.");
      return new Promise<void>((resolve) => {
        this.credit = resolve;
        this.options.post({
          kind: "pullHTTP",
          id: this.options.id,
          sequence: this.next,
        });
      });
    } catch {
      this.fail();
      return Promise.resolve();
    }
  }
  private headers(message: Extract<HostEvent, { kind: "nativeHTTPStream" }>) {
    if (this.opened) throw new Error("Duplicate native stream headers.");
    const head = NativeHTTPStreamHead.parse(message.result);
    if (head.url !== this.options.request.url)
      throw new Error("Native stream URL changed.");
    const empty = [204, 205, 304].includes(head.status);
    const body = empty
      ? null
      : new ReadableStream<Uint8Array>(
          {
            start: (controller) => {
              this.body = controller;
            },
            pull: () => this.pull(),
            cancel: () => this.fail(),
          },
          { highWaterMark: 0 },
        );
    const response = new Response(body, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
    });
    Object.defineProperty(response, "url", { value: head.url });
    this.current();
    this.opened = true;
    if (empty) {
      this.finish();
      this.cancel();
    }
    this.resolve(response);
  }
  private chunk(message: Extract<HostEvent, { kind: "nativeHTTPChunk" }>) {
    const value = NativeHTTPStreamChunk.parse(message.result);
    if (
      !this.opened ||
      !this.credit ||
      value.sequence !== this.next ||
      this.bytes + value.body.byteLength > 4_194_304
    )
      throw new Error("Invalid native stream credit.");
    const body = new Uint8Array(value.body);
    this.current();
    this.bytes += body.byteLength;
    this.next++;
    const settle = this.credit;
    this.credit = undefined;
    if (body.byteLength) this.body?.enqueue(body);
    if (value.eof) {
      this.body?.close();
      this.finish();
    }
    settle();
  }
  complete(message: HostEvent) {
    if (this.ended) return;
    try {
      this.current();
      if (message.kind === "nativeHTTPStream") this.headers(message);
      else if (message.kind === "nativeHTTPChunk") this.chunk(message);
      else throw new Error("Unexpected native stream response.");
    } catch {
      this.fail();
    }
  }
}
export function wantsNativeStream(request: Request): boolean {
  return (
    request.method !== "HEAD" &&
    (request.headers.get("accept") ?? "")
      .split(",")
      .some(
        (part) =>
          part.split(";")[0]?.trim().toLowerCase() === "text/event-stream",
      )
  );
}
