/** One-use request/result ordering DATA. Only the private Store can register REAL membership. */
import { z } from "zod";

const operation = z.strictObject({ kind: z.literal("export-sealed") });
export type OriginalRealOperationRequest = z.infer<typeof operation>;
/** A purpose-limited capability is constructed and registered only in the private Store. Structural shape is never authentication. */
export type OriginalRealOperationRealm = Readonly<{
  exportSealed: () => Promise<string>;
  exit: () => Promise<void>;
}>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function unavailable(): never {
  throw new Error("Original REAL operation is unavailable.");
}

/** Constructing this transport, presenting metadata, or accepting DATA cannot mint a Store handle. */
export class OriginalRealOperationTurn {
  readonly #request = deferred<OriginalRealOperationRequest>();
  readonly #result = deferred<string>();
  readonly #signal: AbortSignal;
  #requested = false;
  #closed = false;
  #accepted: string | undefined;
  readonly #abort = () =>
    this.close(new Error("Original REAL operation ended."));
  constructor(signal: AbortSignal) {
    this.#signal = signal;
    signal.addEventListener("abort", this.#abort, { once: true });
    if (signal.aborted) this.#abort();
    Object.freeze(this);
  }
  check = (): void => {
    if (this.#closed || this.#signal.aborted) unavailable();
  };
  execute = (input: OriginalRealOperationRequest): Promise<string> => {
    this.check();
    if (this.#requested) unavailable();
    const request = Object.freeze(operation.parse(input));
    this.#requested = true;
    this.#request.resolve(request);
    return this.#result.promise;
  };
  next = async (): Promise<OriginalRealOperationRequest> => {
    this.check();
    const request = await this.#request.promise;
    this.check();
    return request;
  };
  accept = (ciphertext: string): void => {
    this.check();
    if (!this.#requested || this.#accepted !== undefined) unavailable();
    this.#accepted = ciphertext;
  };
  /** Private caller invokes this only after its accepted producer closes and literal leases release. */
  finish = (): void => {
    this.check();
    if (this.#accepted === undefined) unavailable();
    this.#result.resolve(this.#accepted);
    this.#retire();
  };
  close = (cause: unknown): void => {
    this.#request.reject(cause);
    this.#result.reject(cause);
    this.#retire();
  };
  #retire(): void {
    this.#closed = true;
    this.#accepted = undefined;
    this.#signal.removeEventListener("abort", this.#abort);
  }
}
