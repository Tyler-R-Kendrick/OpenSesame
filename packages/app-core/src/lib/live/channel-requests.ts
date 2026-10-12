/**
 * The joiner's numbered requests over a session's channel (ADR 0150 §5): a
 * reveal, a copy or an edit goes out with an id, and the owner's `value` or
 * `denied` with that id answers it. Every request is answered — with the
 * value, or with null when the owner refused, the frame could not go out, or
 * the channel went away first.
 */

import type { ChannelMessage } from "./messages.js";
import type { LiveChannel } from "./p2p.js";

/** A request as the joiner asks it; the id is added here. */
export type ChannelRequest =
  | Readonly<{ t: "reveal" | "copy"; item: string; field: string }>
  | Readonly<{ t: "edit"; item: string; field: string; value: string }>;

export class ChannelRequests {
  readonly #pending = new Map<string, (value: string | null) => void>();
  #next = 0;

  /** Send one request; its answer, or null. */
  call(channel: LiveChannel, request: ChannelRequest): Promise<string | null> {
    this.#next += 1;
    const req = `r${this.#next}`;
    return new Promise((resolve) => {
      this.#pending.set(req, resolve);
      if (channel.send({ ...request, req })) return;
      this.#pending.delete(req);
      resolve(null);
    });
  }

  /** An answer from the owner; one for no request is ignored. */
  answer(message: Extract<ChannelMessage, { t: "value" | "denied" }>): void {
    const resolve = this.#pending.get(message.req);
    this.#pending.delete(message.req);
    resolve?.(message.t === "value" ? message.value : null);
  }

  /** The channel is gone: every request still out is answered null. */
  drop(): void {
    for (const resolve of this.#pending.values()) resolve(null);
    this.#pending.clear();
  }
}
