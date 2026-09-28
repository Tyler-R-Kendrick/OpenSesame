/**
 * One admitted guest, from the owner's side (ADR 0148 §5).
 *
 * The owner's vault key never crosses. What does: the catalog — shared
 * items' names and types, and their fields, with a concealed field's value
 * left out — and then one concealed value at a time, on request. Every
 * request is checked again against the session as it stands now: still
 * within its time, the item still shared, the field one that exists and is
 * concealed, and `reveal` only under the `read` policy. Every answer lands in
 * the owner's on-screen log.
 */

import { type Catalog, type ChannelMessage, VALUE_MAX } from "./messages.js";
import {
  type IceSettings,
  type PeerChannel,
  type PeerFactory,
  answerOffer,
} from "./peer.js";

/** One answer to a guest's request, as the owner's log shows it. */
export type LogEntry = Readonly<{
  at: number;
  guest: string;
  what: "reveal" | "copy" | "denied";
  item: string;
  field: string;
}>;

/** A concealed field's value from the open vault, or null. */
export type ReadField = (item: string, field: string) => Promise<string | null>;

export type HostPeerOptions = Readonly<{
  guest: string;
  ice: IceSettings;
  peers: PeerFactory;
  catalog: () => Catalog;
  readField: ReadField;
  expiresAt: number;
  now: () => number;
  onJoined: () => void;
  onClosed: () => void;
  onLog: (entry: LogEntry) => void;
}>;

type Request = Extract<ChannelMessage, { t: "reveal" | "copy" }>;

export class HostPeer {
  #pc: RTCPeerConnection | null = null;
  #channel: PeerChannel | null = null;
  #closed = false;

  constructor(private readonly options: HostPeerOptions) {}

  /**
   * Answer the joiner's offer — the admission — and return the answer for
   * the reply code. The channel opens once the joiner pastes that reply.
   */
  async open(offer: string): Promise<string> {
    const side = await answerOffer(this.options.peers, this.options.ice, offer);
    this.#pc = side.pc;
    side.pc.addEventListener("connectionstatechange", () => {
      if (side.pc.connectionState === "failed") this.#closedByPeer();
    });
    side.channel.then(
      (channel) => this.#connected(channel),
      () => this.#closedByPeer(),
    );
    return side.answer;
  }

  #connected(channel: PeerChannel): void {
    if (this.#closed) {
      channel.close();
      return;
    }
    this.#channel = channel;
    channel.onClose(() => this.#closedByPeer());
    channel.onMessage((message) => void this.#handle(message));
    channel.send({ t: "catalog", catalog: this.options.catalog() });
    this.options.onJoined();
  }

  #closedByPeer(): void {
    if (this.#closed) return;
    this.close();
    this.options.onClosed();
  }

  async #handle(message: ChannelMessage): Promise<void> {
    if (message.t !== "reveal" && message.t !== "copy") return;
    const value = await this.#answerFor(message);
    this.options.onLog({
      at: this.options.now(),
      guest: this.options.guest,
      what: value === null ? "denied" : message.t,
      item: message.item,
      field: message.field,
    });
    this.#channel?.send(
      value === null
        ? { t: "denied", req: message.req }
        : { t: "value", req: message.req, value },
    );
  }

  async #answerFor(request: Request): Promise<string | null> {
    if (this.#closed || this.options.now() >= this.options.expiresAt)
      return null;
    const catalog = this.options.catalog();
    if (request.t === "reveal" && catalog.policy !== "read") return null;
    const item = catalog.items.find((entry) => entry.id === request.item);
    const field = item?.fields.find((entry) => entry.key === request.field);
    if (!item || !field?.concealed) return null;
    const value = await this.options.readField(item.id, field.key);
    return value !== null && value.length <= VALUE_MAX ? value : null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel?.send({ t: "end" });
    this.#channel?.close();
    this.#pc?.close();
  }
}
