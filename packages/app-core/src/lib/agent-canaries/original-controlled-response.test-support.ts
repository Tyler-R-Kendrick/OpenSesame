/** Native Web Response/ReadableStream fault controls; injected slots and liveness failures are delivery doubles, never Root proof. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { readOriginalControlledResponseData } from "./original-controlled-response-data.js";
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
export type NativeResponseFault = Readonly<{
  name: string;
  closeAfterChunk?: true;
  bytes?: Uint8Array;
  work?: ErrorOptions;
  cancel?: ErrorOptions;
  slot?: Readonly<{
    name: "cancel" | "releaseLock";
    failure: ErrorOptions;
    recovers: boolean;
  }>;
}>;
export type NativeResponseOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: ErrorOptions }>;
function observe<T>(accepted: Promise<T>): Promise<NativeResponseOutcome<T>> {
  return accepted.then(
    (value) => ({ ok: true, value }),
    (cause) => ({ ok: false, failure: { cause } }),
  );
}
function refuse<T>(failures: readonly T[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Native response control and independent teardown failed.",
    );
}
type OriginalResponseNativeCallable =
  | (() => ReadableStreamDefaultReader<Uint8Array>)
  | ReadableStreamDefaultReader<Uint8Array>["read" | "cancel" | "releaseLock"];
export class NativeResponseControl {
  readonly bytes: Uint8Array = new TextEncoder().encode(
    '{"native":"delivered"}',
  );
  readonly stream: ReadableStream<Uint8Array>;
  readonly response: Response;
  readonly #input: NativeResponseFault;
  readonly #restore: (() => void)[] = [];
  #cancel: (() => Promise<void>) | undefined;
  #release: (() => void) | undefined;
  #accepted: Promise<NativeResponseOutcome<BoundaryValue>> | undefined;
  reads = 0;
  readCalls = 0;
  cancelCalls = 0;
  cancellations = 0;
  aborts = 0;
  getters = 0;
  maliciousCalls = 0;
  constructor(input: NativeResponseFault) {
    this.#input = input;
    if (input.bytes) this.bytes = input.bytes;
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          this.reads++;
          controller.enqueue(this.bytes);
          if (input.closeAfterChunk) controller.close();
        },
        cancel: () => {
          this.cancellations++;
          if (input.cancel) throw input.cancel.cause;
        },
      },
      { highWaterMark: 0 },
    );
    this.response = new Response(this.stream, {
      headers: { "Content-Type": "application/json" },
    });
    const acquire: () => ReadableStreamDefaultReader<Uint8Array> = bindOriginal(
      this.stream.getReader,
      this.stream,
    );
    const delivered = () => this.#deliver(acquire());
    this.#poison(delivered);
    Object.defineProperty(this.stream, "getReader", {
      configurable: true,
      value: delivered,
    });
  }
  #poison(entry: OriginalResponseNativeCallable) {
    for (const name of ["call", "bind"]) {
      const prior = Object.getOwnPropertyDescriptor(entry, name);
      this.#restore.push(() => {
        if (prior) Object.defineProperty(entry, name, prior);
        else if (!Reflect.deleteProperty(entry, name))
          throw new Error("Original native entry restoration refused.");
      });
      Object.defineProperty(entry, name, {
        configurable: true,
        value: () => {
          this.maliciousCalls++;
          throw new Error("Mutable dispatch was invoked.");
        },
      });
    }
  }
  #deliver(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const originalRead: typeof reader.read = bindOriginal(reader.read, reader);
    const originalCancel: typeof reader.cancel = bindOriginal(
      reader.cancel,
      reader,
    );
    const read: typeof reader.read = () => {
      this.readCalls++;
      return originalRead();
    };
    const cancel: typeof reader.cancel = () => {
      this.cancelCalls++;
      return originalCancel();
    };
    const release: typeof reader.releaseLock = bindOriginal(
      reader.releaseLock,
      reader,
    );
    this.#cancel = () => cancel();
    this.#release = () => release();
    for (const entry of [read, cancel, release]) this.#poison(entry);
    Object.defineProperties(reader, {
      read: { configurable: true, value: read },
      cancel: { configurable: true, value: cancel },
      releaseLock: { configurable: true, value: release },
    });
    const slot = this.#input.slot;
    if (slot) {
      const original = slot.name === "cancel" ? cancel : release;
      Object.defineProperty(reader, slot.name, {
        configurable: true,
        get: () => {
          this.getters++;
          if (this.getters === 1 || !slot.recovers) throw slot.failure.cause;
          return original;
        },
      });
    }
    return reader;
  }
  run(): Promise<NativeResponseOutcome<BoundaryValue>> {
    if (this.#accepted) throw new Error("Native control already started.");
    this.#accepted = observe(
      readOriginalControlledResponseData({
        response: this.response,
        original: () => {
          if (this.reads && this.#input.work) throw this.#input.work.cause;
        },
        abort: () => {
          this.aborts++;
        },
      }),
    );
    return this.#accepted;
  }
  async finish(
    checked: boolean,
    prior: readonly ErrorOptions[],
  ): Promise<void> {
    const failures: unknown[] = prior.map((item) => item.cause);
    for (const cleanup of [
      () => (this.stream.locked ? this.#cancel?.() : this.stream.cancel()),
      () => (this.stream.locked ? this.#release?.() : undefined),
      ...this.#restore,
      () => this.bytes.fill(0),
    ]) {
      try {
        await cleanup();
      } catch (cause) {
        failures.push(cause);
      }
    }
    const outcome = await this.#accepted;
    if (outcome && !outcome.ok && (!checked || failures.length))
      failures.unshift(outcome.failure.cause);
    refuse(failures);
  }
}
export async function withNativeResponseControl(
  input: NativeResponseFault,
  work: (control: NativeResponseControl) => Promise<void>,
): Promise<void> {
  const control = new NativeResponseControl(input);
  let failure: ErrorOptions | undefined;
  let checked = false;
  try {
    await work(control);
    checked = true;
  } catch (cause) {
    failure = { cause };
  }
  await control.finish(checked, failure ? [failure] : []);
}
