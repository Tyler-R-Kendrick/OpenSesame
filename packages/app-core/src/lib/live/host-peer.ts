/**
 * One admitted guest, from the owner's side (ADR 0150 §5).
 *
 * The owner's vault key never crosses. What does: the catalog — shared
 * items' names and types, and their fields, with a concealed field's value
 * left out — and then one concealed value at a time, on request. Under
 * `edit`, a joiner may also replace one shared field. Every request is
 * checked again against the session as it stands now: still within its time,
 * the item still shared, the field one that exists. `reveal` and `copy` run
 * only under `read` or `edit`. Copy only (`use`) refuses both, so a concealed
 * value is not handed to the joiner to place on their clipboard. `edit`
 * writes only under `edit`. Every answer lands in the owner's on-screen log.
 */

import {
  type Catalog,
  type ChannelMessage,
  VALUE_MAX,
  characters,
} from "./messages.js";
import { type IceSettings, type PeerFactory, answerOffer } from "./peer.js";
import type { Carrier } from "./rendezvous.js";
import type { Keypair } from "./seal.js";
import {
  type LiveChannel,
  SeatChannel,
  type SeatKeys,
} from "./seat-channel.js";

/** One answer to a guest's request, as the owner's log shows it. */
export type LogEntry = Readonly<{
  at: number;
  guest: string;
  what: "reveal" | "copy" | "edit" | "denied";
  item: string;
  field: string;
}>;

/** A concealed field's value from the open vault, or null. */
export type ReadField = (item: string, field: string) => Promise<string | null>;

/** Replace one shared field in the open vault. False when it was refused. */
export type WriteField = (
  item: string,
  field: string,
  value: string,
) => Promise<boolean>;

export type HostPeerOptions = Readonly<{
  guest: string;
  ice: IceSettings;
  peers: PeerFactory;
  catalog: () => Catalog;
  readField: ReadField;
  writeField?: WriteField;
  expiresAt: number;
  now: () => number;
  onJoined: () => void;
  onClosed: () => void;
  onLog: (entry: LogEntry) => void;
  /**
   * The seat is also offered over a NATS carrier (ADR 0167): a peer route
   * that fails does not end it, since the joiner may still arrive there.
   */
  relayed?: boolean;
}>;

/**
 * How long a seat offered over a relay has to connect, one way or the other:
 * a peer route that never opens does not always say it failed, and a joiner
 * who cannot reach the relay either never sends a frame there.
 */
export const RELAY_GRACE_MS = 60_000;

type Request = Extract<ChannelMessage, { t: "reveal" | "copy" }>;
type EditRequest = Extract<ChannelMessage, { t: "edit" }>;

export class HostPeer {
  #pc: RTCPeerConnection | null = null;
  #channel: LiveChannel | null = null;
  /** The seat's relay, listening until the joiner's first frame. */
  #relay: LiveChannel | null = null;
  #grace: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(private readonly options: HostPeerOptions) {}

  /**
   * Answer the joiner's offer — the admission — and return the answer for
   * the reply code. The channel opens once the joiner pastes that reply.
   */
  async open(offer: string): Promise<string> {
    const side = await answerOffer(this.options.peers, this.options.ice, offer);
    // Closed while the browser was gathering: `close()` found no connection
    // to close, so this is the only place that can.
    if (this.#closed) {
      side.pc.close();
      side.channel.catch(() => undefined);
      throw new Error("closed");
    }
    this.#pc = side.pc;
    side.pc.addEventListener("connectionstatechange", () => {
      if (side.pc.connectionState === "failed") this.#peerFailed();
    });
    side.channel.then(
      (channel) => {
        // The joiner already moved the seat to the relay: the late peer
        // route is not the session.
        if (this.#channel !== null) channel.close();
        else this.#connected(channel);
      },
      () => this.#peerFailed(),
    );
    return side.answer;
  }

  /** The peer route failed: the seat ends, unless a relay may still carry it. */
  #peerFailed(): void {
    if (this.options.relayed !== true) this.#closedByPeer();
  }

  /** Seal the seat's relay with the pairing's keys and listen on it. */
  async relayVia(
    relay: Carrier,
    owner: Keypair,
    seat: Omit<SeatKeys, "shared">,
  ): Promise<void> {
    const shared = await owner.shared(seat.joiner);
    if (!shared) {
      relay.close();
      throw new Error("bad_joiner_key");
    }
    this.offerRelay(new SeatChannel(relay, { ...seat, shared }, "owner"));
  }

  /**
   * Listen for this seat on its relay. The joiner's first frame there moves
   * the session onto it: the peer route, if it opened, is closed.
   */
  offerRelay(channel: LiveChannel): void {
    if (this.#closed) {
      channel.close();
      return;
    }
    this.#relay = channel;
    if (!this.#channel && !this.#grace)
      this.#grace = setTimeout(() => {
        this.#grace = null;
        if (!this.#channel) this.#closedByPeer();
      }, RELAY_GRACE_MS);
    channel.onMessage(() => this.#adopt(channel));
    channel.onClose(() => {
      if (this.#relay === channel) this.#relay = null;
    });
  }

  #adopt(channel: LiveChannel): void {
    if (this.#closed || this.#channel === channel) return;
    this.#relay = null;
    const previous = this.#channel;
    this.#channel = null;
    previous?.close();
    this.#pc?.close();
    this.#pc = null;
    this.#connected(channel);
  }

  #connected(channel: LiveChannel): void {
    if (this.#closed) {
      channel.close();
      return;
    }
    if (this.#grace) clearTimeout(this.#grace);
    this.#grace = null;
    this.#channel = channel;
    channel.onClose(() => {
      if (this.#channel === channel) this.#closedByPeer();
    });
    channel.onMessage((message) => void this.#handle(message));
    // A guest that never receives the catalog is not in the session: say so
    // by ending it, not by counting them joined.
    if (!channel.send({ t: "catalog", catalog: this.options.catalog() })) {
      this.#closedByPeer();
      return;
    }
    this.options.onJoined();
  }

  #closedByPeer(): void {
    if (this.#closed) return;
    this.close();
    this.options.onClosed();
  }

  async #handle(message: ChannelMessage): Promise<void> {
    if (message.t === "edit") {
      await this.#save(message);
      return;
    }
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
    // Copy only keeps the concealed plaintext on this device. It is not
    // revealed, and it is not returned for the joiner to copy.
    if (catalog.policy === "use") return null;
    const item = catalog.items.find((entry) => entry.id === request.item);
    const field = item?.fields.find((entry) => entry.key === request.field);
    if (!item || !field?.concealed) return null;
    const value = await this.options.readField(item.id, field.key);
    return value !== null && value.length <= VALUE_MAX ? value : null;
  }

  async #save(message: EditRequest): Promise<void> {
    const value = await this.#commit(message);
    this.options.onLog({
      at: this.options.now(),
      guest: this.options.guest,
      what: value === null ? "denied" : "edit",
      item: message.item,
      field: message.field,
    });
    this.#channel?.send(
      value === null
        ? { t: "denied", req: message.req }
        : { t: "value", req: message.req, value },
    );
  }

  async #commit(message: EditRequest): Promise<string | null> {
    if (this.#closed || this.options.now() >= this.options.expiresAt)
      return null;
    const catalog = this.options.catalog();
    if (catalog.policy !== "edit") return null;
    const item = catalog.items.find((entry) => entry.id === message.item);
    const field = item?.fields.find((entry) => entry.key === message.field);
    const write = this.options.writeField;
    if (!item || !field || !write || characters(message.value) > VALUE_MAX)
      return null;
    try {
      const saved = await write(item.id, field.key, message.value);
      return saved ? message.value : null;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#grace) clearTimeout(this.#grace);
    this.#grace = null;
    this.#channel?.send({ t: "end" });
    this.#channel?.close();
    this.#relay?.close();
    this.#relay = null;
    this.#pc?.close();
  }
}
