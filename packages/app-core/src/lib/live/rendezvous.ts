/**
 * Carriers: optional relays that pass a live session's pairing codes so the
 * two people do not have to (ADR 0148 §6).
 *
 * A carrier is any publish/subscribe service both browsers can reach —
 * Nostr, MQTT or NATS over WebSocket, ntfy, or this browser's own tabs. The
 * shell supplies them (`CarrierFactory`), each loading its client only when
 * a session names it; app-core only posts and listens.
 *
 * What a carrier sees is a topic derived from the link secret, so only link
 * holders can name it, and sealed codes on it: a request only the owner can
 * open, a reply only its joiner can (`pairing.ts`). What anyone else posts
 * there fails the outer seal and is dropped uncounted. Codes are split into
 * frames small enough for the strictest carrier (ntfy's 4 KB message), and
 * reassembled with bounds on how many and how long.
 *
 * A carrier that cannot be reached costs nothing: pasting the codes by hand
 * works beside it, always.
 */

import { fromB64url, toB64url } from "./seal.js";
import type { CarrierSpec } from "./transport.js";

export type Carrier = Readonly<{
  post(text: string): Promise<void>;
  /** Hear every frame on the topic; returns how to stop. */
  listen(onText: (text: string) => void): () => void;
  close(): void;
}>;

/** Open one carrier on one topic; rejects if it cannot be reached. */
export type CarrierFactory = (
  spec: CarrierSpec,
  topic: string,
) => Promise<Carrier>;

export type CarrierState = Readonly<{
  spec: CarrierSpec;
  status: "connecting" | "ready" | "failed";
}>;

const FRAME_PREFIX = "osl1";
const CHUNK = 2800;
const MAX_PARTS = 40;
const MAX_PENDING = 32;
const PENDING_MS = 5 * 60_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The topic for a link: 22 base64url characters only link holders know. */
export async function carrierTopic(secret: string): Promise<string> {
  const bytes = fromB64url(secret);
  if (!bytes || bytes.length !== 32) throw new Error("bad_link_secret");
  const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("osm-live-v1 topic"),
    },
    base,
    128,
  );
  return toB64url(new Uint8Array(bits));
}

/** `text` as frames: `osl1.<id>.<index>.<count>.<chunk>`. */
export function toFrames(text: string): string[] {
  const id = toB64url(crypto.getRandomValues(new Uint8Array(8)));
  const count = Math.max(1, Math.ceil(text.length / CHUNK));
  if (count > MAX_PARTS) throw new Error("code_too_large");
  const frames: string[] = [];
  for (let at = 0; at < count; at += 1)
    frames.push(
      [
        FRAME_PREFIX,
        id,
        at,
        count,
        text.slice(at * CHUNK, (at + 1) * CHUNK),
      ].join("."),
    );
  return frames;
}

type Frame = Readonly<{ id: string; at: number; of: number; chunk: string }>;

/** One frame, read strictly; null for anything that is not one. */
function readFrame(text: string): Frame | null {
  if (text.length > CHUNK + 64) return null;
  const [prefix, id, index, count, ...rest] = text.split(".");
  if (prefix !== FRAME_PREFIX || !id || !MESSAGE_ID.test(id)) return null;
  const at = Number(index);
  const of = Number(count);
  if (!Number.isInteger(at) || !Number.isInteger(of)) return null;
  if (of < 1 || of > MAX_PARTS || at < 0 || at >= of) return null;
  return { id, at, of, chunk: rest.join(".") };
}

type Pending = { parts: (string | undefined)[]; seen: number; since: number };

/** Frames back into codes: bounded in number, size and age. */
export class Reassembler {
  readonly #pending = new Map<string, Pending>();
  readonly #done = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The whole code once its last frame arrives; null until then. */
  push(text: string): string | null {
    const frame = readFrame(text);
    if (!frame || this.#done.has(frame.id)) return null;
    const { id, at, of, chunk } = frame;
    this.#expire();
    let pending = this.#pending.get(id);
    if (!pending) {
      if (this.#pending.size >= MAX_PENDING) return null;
      pending = {
        parts: new Array(of).fill(undefined),
        seen: 0,
        since: this.now(),
      };
      this.#pending.set(id, pending);
    }
    if (pending.parts.length !== of || pending.parts[at] !== undefined)
      return null;
    pending.parts[at] = chunk;
    pending.seen += 1;
    if (pending.seen < of) return null;
    this.#pending.delete(id);
    this.#done.add(id);
    if (this.#done.size > 512) this.#done.clear();
    return pending.parts.join("");
  }

  #expire(): void {
    const cutoff = this.now() - PENDING_MS;
    for (const [id, pending] of this.#pending)
      if (pending.since < cutoff) this.#pending.delete(id);
  }
}

/**
 * Every carrier a session names, opened on its topic: post a code to all of
 * them, hear a code from any. One that fails is marked and left alone.
 */
export class Rendezvous {
  readonly #carriers: (Carrier | null)[];
  readonly #states: CarrierState[];
  readonly #listeners = new Set<(states: readonly CarrierState[]) => void>();
  readonly #stops: (() => void)[] = [];
  readonly #reassembler = new Reassembler();
  readonly #waiting: (() => void)[] = [];
  #closed = false;

  private constructor(specs: readonly CarrierSpec[]) {
    this.#carriers = specs.map(() => null);
    this.#states = specs.map((spec) => ({ spec, status: "connecting" }));
  }

  /** Open each carrier; `onCode` hears every whole code any of them passes. */
  static open(
    specs: readonly CarrierSpec[],
    secret: string,
    factory: CarrierFactory,
    onCode: (code: string) => void,
  ): Rendezvous {
    const rendezvous = new Rendezvous(specs);
    void carrierTopic(secret).then((topic) =>
      specs.forEach((spec, at) => {
        factory(spec, topic).then(
          (carrier) => rendezvous.#ready(at, carrier, onCode),
          () => rendezvous.#mark(at, "failed"),
        );
      }),
    );
    return rendezvous;
  }

  get states(): readonly CarrierState[] {
    return [...this.#states];
  }

  subscribe(listener: (states: readonly CarrierState[]) => void): () => void {
    this.#listeners.add(listener);
    listener(this.states);
    return () => this.#listeners.delete(listener);
  }

  #mark(at: number, status: CarrierState["status"]): void {
    const state = this.#states[at];
    if (!state || this.#closed) return;
    this.#states[at] = { ...state, status };
    for (const listener of this.#listeners) listener(this.states);
    // Nothing left to wait for once every carrier has failed.
    if (this.#states.every((entry) => entry.status === "failed"))
      for (const waiter of this.#waiting.splice(0)) waiter();
  }

  #ready(at: number, carrier: Carrier, onCode: (code: string) => void): void {
    if (this.#closed) {
      carrier.close();
      return;
    }
    this.#carriers[at] = carrier;
    this.#stops.push(
      carrier.listen((frame) => {
        const code = this.#reassembler.push(frame);
        if (code !== null) onCode(code);
      }),
    );
    this.#mark(at, "ready");
    for (const waiter of this.#waiting.splice(0)) waiter();
  }

  /** Resolves once any carrier is ready, or after `ms`. */
  whenReady(ms: number): Promise<void> {
    if (this.#carriers.some((carrier) => carrier !== null))
      return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Post a code on every carrier that is ready. */
  async post(code: string): Promise<void> {
    const frames = toFrames(code);
    await Promise.allSettled(
      this.#carriers.map(async (carrier) => {
        if (!carrier) return;
        for (const frame of frames) await carrier.post(frame);
      }),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stop of this.#stops.splice(0)) stop();
    for (const carrier of this.#carriers) carrier?.close();
    for (const waiter of this.#waiting.splice(0)) waiter();
    this.#listeners.clear();
  }
}
