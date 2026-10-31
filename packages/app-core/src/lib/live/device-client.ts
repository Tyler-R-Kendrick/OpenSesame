/**
 * A device's side of a live session (ADR 0196): ask the owner's tab for
 * authority, wait for the owner's answer, then name a connection and an
 * operation — over whatever channel the seat has, in a browser or in a
 * terminal.
 *
 * The flow is RFC 8628's. `authorize` sends `dev.begin`, hands the caller the
 * user code to show (the owner compares it on their screen), and then waits:
 * the owner's tab pushes its answer the moment it is made, and the client
 * also polls on the interval it was given, in case a frame was lost. A poll
 * that comes too soon is told `slow_down` and waits longer. The wait ends with
 * a grant, with the owner's refusal, or when the request lapses.
 *
 * Every ask is numbered, and every one is answered or fails: with the owner's
 * code, with a timeout, or because the channel went away.
 */

import {
  type DeviceConnection,
  type DeviceErrorCode,
  type DeviceItem,
  type DeviceMessage,
  type DeviceReply,
  type DeviceRequest,
  isDeviceReply,
} from "./device-messages.js";
import {
  type DeviceResetGrant,
  type DeviceResetRequest,
  type ResetHumanStatus,
  type ResetRequestDetails,
  resetRequestDigest,
} from "./device-reset-messages.js";
import type { LiveGuest } from "./guest.js";

/** Why a device's ask came to nothing. */
export type DeviceFailure =
  | DeviceErrorCode
  | "channel_closed"
  | "timeout"
  | "aborted";

export class DeviceError extends Error {
  constructor(readonly code: DeviceFailure) {
    super(code);
    this.name = "DeviceError";
  }
}

/** What a device needs of a seat's channel. */
export interface DevicePipe {
  /** False when the frame did not go out. */
  send(request: DeviceRequest): boolean;
  /** The one reader of the owner's answers. */
  onMessage(handler: (message: DeviceMessage) => void): void;
  /** The session is over for this seat. */
  onEnd(handler: () => void): void;
}

/** A pipe over a joined guest (a browser tab, or a terminal's relay seat). */
export function devicePipe(guest: LiveGuest): DevicePipe {
  return {
    send: (request) => guest.sendDevice(request),
    onMessage: (handler) => guest.onDevice(handler),
    onEnd: (handler) => {
      guest.subscribe((status) => {
        if (
          status.at === "ended" ||
          status.at === "unreachable" ||
          status.at === "connect_timeout"
        )
          handler();
      });
    },
  };
}

/** What the person at the device is shown while the owner decides. */
export type DeviceCodeView = Readonly<{
  /** What to compare with the owner's screen. */
  userCode: string;
  /** Seconds until the request lapses. */
  expiresIn: number;
}>;

export type DeviceGranted = Readonly<{
  /** When the grant lapses, epoch ms. */
  expiresAt: number;
  connections: readonly DeviceConnection[];
}>;

export type DeviceResult = Readonly<{
  label: string;
  items: readonly DeviceItem[];
  truncated: boolean;
}>;

export type AuthorizeOptions = Readonly<{
  /** Connections to suggest to the owner. A hint, never a grant. */
  want?: readonly string[];
  onCode?: (view: DeviceCodeView) => void;
  signal?: AbortSignal;
}>;

export type ClientOptions = Readonly<{ replyMs?: number }>;

/** How long one ask waits for its answer before the client gives up on it. */
export const REPLY_MS = 30_000;

type Waiter = Readonly<{
  deliver: (message: DeviceReply) => void;
  fail: (error: DeviceError) => void;
}>;

export class DeviceClient {
  readonly #pipe: DevicePipe;
  readonly #replyMs: number;
  readonly #asks = new Map<string, Waiter>();
  /** Answers the owner volunteers, keyed by the ask they belong to. */
  readonly #pushes = new Map<string, (message: DeviceReply) => void>();
  readonly #waits = new Set<Pushed>();
  #next = 0;
  #closed = false;

  constructor(pipe: DevicePipe, options: ClientOptions = {}) {
    this.#pipe = pipe;
    this.#replyMs = options.replyMs ?? REPLY_MS;
    pipe.onMessage((message) => this.#route(message));
    pipe.onEnd(() => this.close());
  }

  #route(message: DeviceMessage): void {
    if (!isDeviceReply(message)) return;
    if (message.t === "dev.auth") this.#pushes.get(message.req)?.(message);
    this.#asks.get(message.req)?.deliver(message);
  }

  /** The session is over: every ask still out fails, and every wait ends. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiting = [...this.#asks.values()];
    this.#asks.clear();
    this.#pushes.clear();
    for (const waiter of waiting)
      waiter.fail(new DeviceError("channel_closed"));
    for (const waiter of [...this.#waits]) waiter.wake();
  }

  #id(): string {
    this.#next += 1;
    return `d${this.#next}`;
  }

  /** Send one ask and take its answer; `take` returns null for a wrong one. */
  #ask<T>(
    build: (req: string) => DeviceRequest,
    take: (message: DeviceReply) => T | null,
    signal?: AbortSignal,
  ): Promise<T> {
    const request = build(this.#id());
    return new Promise<T>((resolve, reject) => {
      if (this.#closed) return reject(new DeviceError("channel_closed"));
      if (signal?.aborted) return reject(new DeviceError("aborted"));
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#asks.delete(request.req);
      };
      const abort = (): void => {
        done();
        reject(new DeviceError("aborted"));
      };
      const timer = setTimeout(() => {
        done();
        reject(new DeviceError("timeout"));
      }, this.#replyMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.#asks.set(request.req, {
        deliver: (message) => {
          done();
          if (message.t === "dev.error") reject(new DeviceError(message.error));
          else {
            const taken = take(message);
            if (taken === null) reject(new DeviceError("invalid_request"));
            else resolve(taken);
          }
        },
        fail: (error) => {
          done();
          reject(error);
        },
      });
      if (!this.#pipe.send(request)) {
        done();
        reject(new DeviceError("channel_closed"));
      }
    });
  }

  /**
   * Ask the owner for authority and wait for the answer. Resolves with the
   * grant; rejects with `access_denied` if the owner said no, `expired_token`
   * if the request lapsed, or another failure.
   */
  async authorize(options: AuthorizeOptions = {}): Promise<DeviceGranted> {
    const want = options.want ?? [];
    // The begin's own number carries the owner's volunteered answer.
    const pushed = new Pushed();
    let beginReq = "";
    let code: Extract<DeviceReply, { t: "dev.code" }>;
    try {
      code = await this.#ask(
        (req) => {
          beginReq = req;
          this.#pushes.set(req, (message) => pushed.put(message));
          return { t: "dev.begin", req, want };
        },
        (message) => (message.t === "dev.code" ? message : null),
        options.signal,
      );
    } catch (error) {
      this.#pushes.delete(beginReq);
      throw error;
    }
    options.onCode?.({ userCode: code.userCode, expiresIn: code.expiresIn });
    this.#waits.add(pushed);
    try {
      return await this.#await(code, pushed, options.signal);
    } finally {
      this.#waits.delete(pushed);
      this.#pushes.delete(beginReq);
    }
  }

  async #await(
    code: Extract<DeviceReply, { t: "dev.code" }>,
    pushed: Pushed,
    signal: AbortSignal | undefined,
  ): Promise<DeviceGranted> {
    const lapses = Date.now() + code.expiresIn * 1000;
    let wait = code.interval;
    for (;;) {
      if (this.#closed) throw new DeviceError("channel_closed");
      if (signal?.aborted) throw new DeviceError("aborted");
      const volunteered = await pushed.within(wait * 1000, signal);
      if (this.#closed) throw new DeviceError("channel_closed");
      let answer = volunteered;
      if (!answer) {
        if (Date.now() >= lapses) throw new DeviceError("expired_token");
        answer = await this.#ask(
          (req) => ({ t: "dev.poll", req, deviceCode: code.deviceCode }),
          (message) => (message.t === "dev.auth" ? message : null),
          signal,
        );
      }
      if (answer.t !== "dev.auth") continue;
      if (answer.state === "granted")
        return {
          expiresAt: answer.expiresAt ?? 0,
          connections: answer.connections ?? [],
        };
      if (answer.state === "access_denied")
        throw new DeviceError("access_denied");
      if (answer.state === "expired_token")
        throw new DeviceError("expired_token");
      if (answer.state === "slow_down") wait = answer.interval ?? wait + 5;
    }
  }

  /** Ask for one exact reset capability under the caller's stable request id. */
  async reset(
    req: string,
    details: ResetRequestDetails,
  ): Promise<DeviceResetGrant> {
    const digest = await resetRequestDigest(details);
    const request: DeviceResetRequest = {
      t: "dev.reset",
      req,
      ...details,
      digest,
    };
    return this.#ask(
      () => request,
      (message) =>
        message.t === "dev.reset.grant" &&
        message.grant === `reset-${req}` &&
        message.digest === digest
          ? message
          : null,
    );
  }

  /** Report value-blind human status for a grant this device holds. */
  resetStatus(
    req: string,
    grant: string,
    status: ResetHumanStatus,
  ): Promise<void> {
    return this.#ask(
      () => ({ t: "dev.reset.status", req, grant, status }),
      (message) => (message.t === "dev.reset.ack" ? undefined : null),
    );
  }

  /** The connections the grant covers, as the owner's tab lists them now. */
  connections(): Promise<readonly DeviceConnection[]> {
    return this.#ask(
      (req) => ({ t: "dev.list", req }),
      (message) => (message.t === "dev.conns" ? message.connections : null),
    );
  }

  /** One operation on one connection the grant covers. */
  call(
    connection: string,
    operation: string,
    input: Readonly<Record<string, string>> = {},
  ): Promise<DeviceResult> {
    return this.#ask(
      (req) => ({ t: "dev.call", req, connection, operation, input }),
      (message) =>
        message.t === "dev.result"
          ? {
              label: message.label,
              items: message.items,
              truncated: message.truncated,
            }
          : null,
    );
  }
}

/**
 * The owner's volunteered answer, or the passing of a poll interval: whichever
 * comes first. An answer that arrives between waits is kept for the next.
 */
class Pushed {
  #held: DeviceReply | null = null;
  #wake: (() => void) | null = null;

  put(message: DeviceReply): void {
    this.#held = message;
    this.#wake?.();
  }

  /** Stop waiting now, with nothing to show for it. */
  wake(): void {
    this.#wake?.();
  }

  /** The volunteered answer, or null once `ms` passed (or `signal` fired). */
  async within(
    ms: number,
    signal: AbortSignal | undefined,
  ): Promise<DeviceReply | null> {
    if (signal?.aborted) throw new DeviceError("aborted");
    if (!this.#held) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        const abort = (): void => done();
        function done(): void {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve();
        }
        signal?.addEventListener("abort", abort);
        this.#wake = done;
      });
      this.#wake = null;
    }
    if (signal?.aborted) throw new DeviceError("aborted");
    const held = this.#held;
    this.#held = null;
    return held;
  }
}
