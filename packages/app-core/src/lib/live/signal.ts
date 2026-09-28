/**
 * Signalling over public Nostr relays (ADR 0148 §3).
 *
 * Each side holds an ephemeral secp256k1 key for the life of one session.
 * A message is a NIP-44 v2 conversation between two such keys, carried in an
 * ephemeral event (kind 25548 — relays forward it and do not store it) that
 * the sender signs and tags with the recipient's key. A relay therefore sees
 * two throwaway public keys and ciphertext; it cannot read, alter or forge a
 * message, and it learns nothing about the vault or the people.
 *
 * The relay network is a port (`SignalTransport`) so the protocol is tested
 * without sockets; `relayTransport` is `nostr-tools`' pool.
 */

import * as nip44 from "nostr-tools/nip44";
import {
  type Event,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure";
import { type Signal, readSignal } from "./messages.js";

export const SIGNAL_KIND = 25548;
/** NIP-44 v2 carries at most 65535 bytes of plaintext. */
const PLAINTEXT_MAX = 60_000;
const SEEN_MAX = 512;

export type SignalFilter = Readonly<{
  kinds: number[];
  "#p": string[];
  since: number;
}>;

export type SignalTransport = Readonly<{
  subscribe: (
    relays: readonly string[],
    filter: SignalFilter,
    onEvent: (event: Event) => void,
  ) => () => void;
  /** Resolves once at least one relay accepted the event. */
  publish: (relays: readonly string[], event: Event) => Promise<void>;
  close: (relays: readonly string[]) => void;
}>;

export type SessionKey = Readonly<{ secret: Uint8Array; pub: string }>;

export function newSessionKey(): SessionKey {
  const secret = generateSecretKey();
  return { secret, pub: getPublicKey(secret) };
}

export type Incoming = Readonly<{ from: string; signal: Signal }>;

/** One key's view of the relays: send to a peer key, hear from any. */
export class Signaller {
  readonly #conversations = new Map<string, Uint8Array>();
  readonly #seen = new Set<string>();
  #stop: (() => void) | null = null;

  constructor(
    private readonly me: SessionKey,
    private readonly relays: readonly string[],
    private readonly transport: SignalTransport,
    private readonly now: () => number = Date.now,
  ) {}

  get pub(): string {
    return this.me.pub;
  }

  #conversation(peer: string): Uint8Array {
    let key = this.#conversations.get(peer);
    if (!key) {
      key = nip44.v2.utils.getConversationKey(this.me.secret, peer);
      this.#conversations.set(peer, key);
    }
    return key;
  }

  /** Start hearing messages addressed to this key. */
  listen(onSignal: (incoming: Incoming) => void): void {
    this.#stop?.();
    const since = Math.floor(this.now() / 1000) - 60;
    this.#stop = this.transport.subscribe(
      this.relays,
      { kinds: [SIGNAL_KIND], "#p": [this.me.pub], since },
      (event) => {
        const incoming = this.#open(event);
        if (incoming) onSignal(incoming);
      },
    );
  }

  #open(event: Event): Incoming | null {
    if (this.#seen.has(event.id)) return null;
    if (this.#seen.size >= SEEN_MAX) this.#seen.clear();
    this.#seen.add(event.id);
    if (event.kind !== SIGNAL_KIND || !verifyEvent(event)) return null;
    const addressed = event.tags.some(
      (tag) => tag[0] === "p" && tag[1] === this.me.pub,
    );
    if (!addressed || event.pubkey === this.me.pub) return null;
    if (event.content.length > PLAINTEXT_MAX * 2) return null;
    try {
      const plain = nip44.v2.decrypt(
        event.content,
        this.#conversation(event.pubkey),
      );
      const signal = readSignal(plain);
      return signal ? { from: event.pubkey, signal } : null;
    } catch {
      return null;
    }
  }

  /** Send one message to a peer key. */
  async send(to: string, signal: Signal): Promise<void> {
    const plain = JSON.stringify(signal);
    if (plain.length > PLAINTEXT_MAX) throw new Error("signal_too_large");
    const event = finalizeEvent(
      {
        kind: SIGNAL_KIND,
        created_at: Math.floor(this.now() / 1000),
        tags: [["p", to]],
        content: nip44.v2.encrypt(plain, this.#conversation(to)),
      },
      this.me.secret,
    );
    await this.transport.publish(this.relays, event);
  }

  close(): void {
    this.#stop?.();
    this.#stop = null;
    this.transport.close(this.relays);
  }
}
