/** Primitive UI exchange only. The actual private Store owns each handle and its authentication task. */
import { z } from "zod";
import type { projectRetiredCredentialInspection } from "../retired-credentials/inspection-v2.js";
import { readRetiredRecordChange } from "../retired-credentials/record-change-v2.js";
import type { RetiredRecordChange } from "../retired-credentials/record-change-v2.js";

const secondStep = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("totp"), code: z.string().max(64) }),
  z.strictObject({ kind: z.literal("remote"), code: z.string().max(64) }),
  z.strictObject({ kind: z.literal("recovery"), code: z.string().max(256) }),
]);
export type RetiredSecondStepRequest = z.infer<typeof secondStep>;
export type RetiredCommand = Readonly<
  { kind: "inspect" } | { kind: "change"; change: RetiredRecordChange }
>;
export type RetiredCommandResult = ReturnType<
  typeof projectRetiredCredentialInspection
>;
declare const originalChallenge: unique symbol;
export type RetiredOperationChallenge = Readonly<{ [originalChallenge]: true }>;
export type RetiredOperationStarted<T extends object = RetiredCommandResult> =
  Readonly<
    | { kind: "complete"; result: T }
    | {
        kind: "challenge";
        challenge: RetiredOperationChallenge;
        routes: readonly ("totp" | "email" | "sms" | "recovery")[];
      }
  >;
export type RetiredRemoteCodeStatus = Readonly<{
  channel: "email" | "sms";
  to: string;
  expiresAt: string;
}>;
export type RetiredOperationMessage = Readonly<
  | { kind: "complete"; request: RetiredSecondStepRequest }
  | {
      kind: "send";
      channel: "email" | "sms";
      acknowledge: (status: RetiredRemoteCodeStatus) => void;
      reject: (cause: unknown) => void;
    }
>;
function unavailable(): never {
  throw new Error("Original retired credential operation is unavailable.");
}
export function copyRetiredCommand(command: RetiredCommand): RetiredCommand {
  if (command.kind === "inspect" && Object.keys(command).length === 1)
    return Object.freeze({ kind: "inspect" });
  if (command.kind === "change" && Object.keys(command).length === 2)
    return Object.freeze({
      kind: "change",
      change: readRetiredRecordChange(command.change),
    });
  unavailable();
}
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
/** No constructor input can establish primary provenance, factors, locks or authority. */
export class RetiredOperationExchange<T extends object = RetiredCommandResult> {
  // SAFETY: Object.freeze creates this empty opaque challenge identifier; the contract requires checked private Store WeakMap membership on every use.
  readonly challenge = Object.freeze({}) as RetiredOperationChallenge;
  readonly controller = new AbortController();
  readonly #started = deferred<RetiredOperationStarted<T>>();
  readonly #finished = deferred<T>();
  #message = deferred<RetiredOperationMessage>();
  #offered = false;
  #submitted = false;
  #sendReply: ReturnType<typeof deferred<RetiredRemoteCodeStatus>> | undefined;
  #closed = false;
  #task: Promise<void> | undefined;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #originalSignal: AbortSignal;
  readonly #callerSignal: AbortSignal | undefined;
  readonly #abort = () => this.cancel();
  constructor(signal: AbortSignal, callerSignal?: AbortSignal) {
    this.#originalSignal = signal;
    this.#callerSignal = callerSignal;
    callerSignal?.addEventListener("abort", this.#abort, { once: true });
    signal.addEventListener("abort", this.#abort, { once: true });
    this.#timer = setTimeout(this.#abort, 120000);
    if (signal.aborted || callerSignal?.aborted) this.cancel();
    Object.freeze(this);
  }
  check = (): void => {
    if (this.#closed || this.controller.signal.aborted) unavailable();
  };
  track = (task: Promise<void>): void => {
    if (this.#task) unavailable();
    this.#task = task;
    void task.catch(() => {});
  };
  started = async (): Promise<RetiredOperationStarted<T>> => {
    try {
      return await this.#started.promise;
    } catch (error) {
      // A rejected pre-handle begin must still await its own accepted producer work.
      await this.#task?.catch(() => {});
      throw error;
    }
  };
  offer = (
    routes: readonly ("totp" | "email" | "sms" | "recovery")[],
  ): void => {
    this.check();
    if (this.#offered || !routes.length) unavailable();
    this.#offered = true;
    this.#started.resolve(
      Object.freeze({
        kind: "challenge",
        challenge: this.challenge,
        routes: Object.freeze([...routes]),
      }),
    );
  };
  next = async (): Promise<RetiredOperationMessage> => {
    this.check();
    const message = await this.#message.promise;
    this.check();
    this.#message = deferred<RetiredOperationMessage>();
    return message;
  };
  send = (channel: "email" | "sms"): Promise<RetiredRemoteCodeStatus> => {
    this.check();
    if (
      !this.#offered ||
      this.#submitted ||
      (channel !== "email" && channel !== "sms")
    )
      unavailable();
    this.#submitted = true;
    const reply = deferred<RetiredRemoteCodeStatus>();
    this.#sendReply = reply;
    this.#message.resolve({
      kind: "send",
      channel,
      acknowledge: (status) => {
        if (this.#sendReply === reply) this.#sendReply = undefined;
        this.#submitted = false;
        if (this.#closed)
          reply.reject(new Error("Original code request ended."));
        else reply.resolve(status);
      },
      reject: (error) => {
        if (this.#sendReply === reply) this.#sendReply = undefined;
        this.#submitted = false;
        reply.reject(error);
      },
    });
    return reply.promise;
  };
  complete = (input: RetiredSecondStepRequest): Promise<T> => {
    this.check();
    if (!this.#offered || this.#submitted) unavailable();
    const request = Object.freeze(secondStep.parse(input));
    this.#submitted = true;
    this.#message.resolve({ kind: "complete", request });
    return this.#finished.promise;
  };
  /** Result handoff only; original task, cancellation and TTL remain active until final producer drain. */
  present = (result: T): void => {
    this.check();
    this.#started.resolve(Object.freeze({ kind: "complete", result }));
    this.#finished.resolve(result);
  };
  settle = (result: T): void => {
    this.check();
    this.#started.resolve(Object.freeze({ kind: "complete", result }));
    this.#finished.resolve(result);
    this.#retire();
  };
  fail = (cause: unknown): void => {
    this.#started.reject(cause);
    this.#finished.reject(cause);
    this.#message.reject(cause);
    this.#sendReply?.reject(cause);
    this.#sendReply = undefined;
    this.#retire();
  };
  #retire(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#originalSignal.removeEventListener("abort", this.#abort);
    this.#callerSignal?.removeEventListener("abort", this.#abort);
  }
  cancel = (): void => {
    this.controller.abort();
    this.fail(new Error("Original retired credential operation ended."));
  };
  drain = async (): Promise<void> => {
    this.cancel();
    await this.#task?.catch(() => {});
  };
}

/** Map membership comes only from the private Store; this helper issues no authentication grant. */
export function requireRetiredOperationExchange<T extends object>(
  entries: RetiredOperationEntries<T>,
  challenge: RetiredOperationChallenge,
): RetiredOperationExchange<T> {
  const entry = entries.get(challenge);
  if (!entry) unavailable();
  return entry;
}

/** Both original checks may cancel; neither issues factors or authority. */
export function cancellationCheck<T extends object>(
  original: () => void,
  exchange: RetiredOperationExchange<T>,
) {
  return () => {
    original();
    exchange.check();
  };
}

/** Private Store-owned registry. Read-only result lifetime never grants a command or REAL authority. */
export class RetiredOperationEntries<T extends object = RetiredCommandResult> {
  readonly #challenges = new WeakMap<
    RetiredOperationChallenge,
    RetiredOperationExchange<T>
  >();
  readonly #results = new WeakMap<T, () => void>();
  #active: RetiredOperationExchange<T> | null = null;
  #revision = 0;
  #reservation: symbol | undefined;
  constructor() {
    Object.freeze(this);
  }
  busy = () => this.#active !== null || this.#reservation !== undefined;
  reserve = () => {
    if (this.busy()) unavailable();
    const token = Symbol("original-authentication-reservation");
    this.#reservation = token;
    return () => {
      if (this.#reservation === token) this.#reservation = undefined;
    };
  };
  set = (
    challenge: RetiredOperationChallenge,
    exchange: RetiredOperationExchange<T>,
  ) => {
    if (this.#active) unavailable();
    this.#active = exchange;
    this.#reservation = undefined;
    this.#revision++;
    this.#challenges.set(challenge, exchange);
  };
  get = (challenge: RetiredOperationChallenge) =>
    this.#challenges.get(challenge);
  delete = (challenge: RetiredOperationChallenge) =>
    this.#challenges.delete(challenge);
  finish = (exchange: RetiredOperationExchange<T>) => {
    this.#challenges.delete(exchange.challenge);
    if (this.#active === exchange) this.#active = null;
  };
  rememberResult = (result: T, original: () => void) => {
    const revision = this.#revision;
    this.#results.set(result, () => {
      if (revision !== this.#revision) unavailable();
      original();
    });
  };
  isResultCurrent = (result: T): boolean => {
    const original = this.#results.get(result);
    if (!original) return false;
    try {
      original();
      return true;
    } catch {
      return false;
    }
  };
}
