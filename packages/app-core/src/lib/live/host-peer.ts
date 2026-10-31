/**
 * One admitted guest, from the owner's side (ADR 0150 §5, ADR 0186).
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
 *
 * The catalog answers the guest's greeting, every time it greets, and the
 * guest is in at the first greeting (`greeting.ts`): sent once, unasked, the
 * moment the channel opened, it was a frame WebRTC can drop, and the joiner
 * waited on it for good. A joiner from before that never greets, and is sent
 * the catalog unasked, as it expects.
 */

import type { DeviceBroker } from "./device-broker.js";
import { isDeviceMessage, isDeviceRequest } from "./device-messages.js";
import type { SeatDevices } from "./device-types.js";
import { GREETINGS_MAX } from "./greeting.js";
import type { GuestConnection } from "./host-types.js";
import { iceStatusLabel } from "./ice-diagnostics.js";
import {
  type Catalog,
  type ChannelMessage,
  type SeatKind,
  type SeatRoute,
  VALUE_MAX,
  characters,
} from "./messages.js";
import type { LiveChannel, PeerLink, PeerTransport } from "./p2p.js";
import type { Carrier } from "./rendezvous.js";
import type { Keypair } from "./seal.js";
import { SeatChannel, type SeatKeys } from "./seat-channel.js";

/** One answer to a guest's request, as the owner's log shows it. */
export type LogEntry = Readonly<{
  at: number;
  guest: string;
  /** `invoke`: a device's call; `item` is the connection, `field` the operation. */
  what: "reveal" | "copy" | "edit" | "denied" | "invoke";
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
  transport: PeerTransport;
  /** The guest greets until it holds the catalog (its request said so). */
  greets: boolean;
  catalog: () => Catalog;
  readField: ReadField;
  writeField?: WriteField | undefined;
  expiresAt: number;
  now: () => number;
  onJoined: () => void;
  onClosed: () => void;
  onLog: (entry: LogEntry) => void;
  /** A person (the default) is shown shared items; a device is shown none. */
  kind?: SeatKind;
  /** Over a peer route (the default), or the relay alone, with no offer. */
  route?: SeatRoute;
  /** The guest's name, as the owner was shown it. */
  name?: string;
  /** Where a device asks to use the owner's connections (ADR 0196). */
  devices?: Pick<DeviceBroker, "seat"> | null;
  /**
   * The seat is also offered over a NATS carrier (ADR 0167): a peer route
   * that fails does not end it, since the joiner may still arrive there.
   */
  relayed?: boolean;
  /** ICE progress while the joiner connects after a reply (P8-3). */
  onConnection?: (connection: GuestConnection | null) => void;
}>;

/**
 * How long a seat offered over a relay has to connect, one way or the other:
 * a peer route that never opens does not always say it failed, and a joiner
 * who cannot reach the relay either never sends a frame there.
 */
export const RELAY_GRACE_MS = 60_000;

/** Per-seat request budget: a slow vault read cannot be multiplied without bound. */
export const MAX_SEAT_REQUESTS = 240;
export const SEAT_REQUEST_WINDOW_MS = 60_000;
/** Concurrent reveal/copy/edit/device asks one seat may hold open. */
export const MAX_SEAT_IN_FLIGHT = 4;

type Request = Extract<ChannelMessage, { t: "reveal" | "copy" }>;
type EditRequest = Extract<ChannelMessage, { t: "edit" }>;

export class HostPeer {
  #peer: PeerLink | null = null;
  #channel: LiveChannel | null = null;
  /** The seat's relay, listening until the joiner's first frame. */
  #relay: LiveChannel | null = null;
  #grace: ReturnType<typeof setTimeout> | null = null;
  #greetings = 0;
  #joined = false;
  #closed = false;
  #lastCatalog: string | null = null;
  /** This seat's end of the device broker; only a device seat has one. */
  readonly #devices: SeatDevices | null;
  #inFlight = 0;
  #requestTimes: number[] = [];

  constructor(private readonly options: HostPeerOptions) {
    this.#devices =
      options.kind === "device" && options.devices
        ? options.devices.seat(
            { key: options.guest, name: options.name ?? options.guest },
            (reply) => void this.#channel?.send(reply),
          )
        : null;
  }

  /**
   * Answer the joiner's offer — the admission — and return the answer for
   * the reply code. The channel opens once the joiner pastes that reply.
   */
  async open(offer: string): Promise<string> {
    // A relay-only seat has no offer to answer: it is carried by the relay.
    if (this.options.route === "relay") return "";
    const peer = await this.options.transport.answer(offer);
    // Closed while the transport was answering: `close()` found no link to
    // close, so this is the only place that can.
    if (this.#closed) {
      peer.channel.catch(() => undefined);
      peer.close();
      throw new Error("closed");
    }
    this.#peer = peer;
    peer.onFailed(() => this.#peerFailed());
    peer.onIce?.((view) => {
      this.options.onConnection?.({
        phase: view.phase,
        detail: iceStatusLabel(view),
      });
    });
    peer.channel.then(
      (channel) => {
        // The joiner already moved the seat to the relay: the late peer
        // route is not the session.
        if (this.#channel !== null) channel.close();
        else this.#connected(channel);
      },
      () => this.#peerFailed(),
    );
    return peer.handshake;
  }

  /** The peer route failed: the seat ends, unless a relay may still carry it. */
  #peerFailed(): void {
    this.options.onConnection?.({
      phase: "failed",
      detail: "No route to the joiner's browser",
    });
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
    channel.onMessage((message) => this.#adopt(channel, message));
    channel.onClose(() => {
      if (this.#relay === channel) this.#relay = null;
    });
  }

  /** The guest's first frame on the relay moves the seat there; it is read. */
  #adopt(channel: LiveChannel, first: ChannelMessage): void {
    if (this.#closed || this.#channel === channel) return;
    this.#relay = null;
    const previous = this.#channel;
    const peer = this.#peer;
    this.#channel = null;
    this.#peer = null;
    previous?.close();
    peer?.close();
    this.#connected(channel);
    void this.#handle(first);
  }

  #connected(channel: LiveChannel): void {
    // A new route starts with no catalog sent on it.
    this.#lastCatalog = null;
    if (this.#closed) {
      channel.close();
      return;
    }
    if (this.#grace) clearTimeout(this.#grace);
    this.#grace = null;
    this.options.onConnection?.({
      phase: "connected",
      detail: "Connected over a direct path",
    });
    this.#channel = channel;
    channel.onClose(() => {
      if (this.#channel === channel) this.#closedByPeer();
    });
    channel.onMessage((message) => void this.#handle(message));
    // A joiner from before ADR 0186 never greets: it is sent the catalog now.
    if (!this.options.greets && this.#sendCatalog()) this.#in();
  }

  /** A greeting is answered with the catalog, a bounded number of times. */
  #greeted(): void {
    if (this.#greetings >= GREETINGS_MAX) return;
    this.#greetings += 1;
    if (this.#sendCatalog()) this.#in();
  }

  /** The catalog this seat may see. Devices see no item (ADR 0196). */
  #catalog(): Catalog {
    return this.options.kind === "device"
      ? { ...this.options.catalog(), policy: "use" as const, items: [] }
      : this.options.catalog();
  }

  /**
   * Send the catalog. A guest it cannot be sent to is not in the session:
   * say so by ending it, not by counting them joined.
   */
  #sendCatalog(): boolean {
    const catalog = this.#catalog();
    if (this.#channel?.send({ t: "catalog", catalog })) {
      this.#lastCatalog = JSON.stringify(catalog);
      return true;
    }
    this.#closedByPeer();
    return false;
  }

  /** Push a changed catalog to an already-joined guest. */
  refreshCatalog(): void {
    if (!this.#channel) return;
    const catalog = this.#catalog();
    const fingerprint = JSON.stringify(catalog);
    if (fingerprint === this.#lastCatalog) return;
    if (this.#channel.send({ t: "catalog", catalog })) {
      this.#lastCatalog = fingerprint;
      return;
    }
    this.#closedByPeer();
  }

  #in(): void {
    if (this.#joined) return;
    this.#joined = true;
    this.options.onJoined();
  }

  #closedByPeer(): void {
    if (this.#closed) return;
    this.close();
    this.options.onClosed();
  }

  async #handle(message: ChannelMessage): Promise<void> {
    if (message.t === "hello") {
      this.#greeted();
      return;
    }
    if (!this.#admitRequest()) {
      if (isDeviceMessage(message)) {
        this.#channel?.send({
          t: "dev.error",
          req: message.req,
          error: "temporarily_unavailable",
        });
      } else if (
        message.t === "reveal" ||
        message.t === "copy" ||
        message.t === "edit"
      ) {
        this.#channel?.send({ t: "denied", req: message.req });
      }
      return;
    }
    this.#inFlight += 1;
    try {
      if (isDeviceMessage(message)) {
        await this.#device(message);
        return;
      }
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
    } finally {
      this.#inFlight -= 1;
    }
  }

  /** A bounded, per-seat window checked before any vault work starts. */
  #admitRequest(): boolean {
    const now = this.options.now();
    this.#requestTimes = this.#requestTimes.filter(
      (at) => now - at < SEAT_REQUEST_WINDOW_MS,
    );
    if (
      this.#requestTimes.length >= MAX_SEAT_REQUESTS ||
      this.#inFlight >= MAX_SEAT_IN_FLIGHT
    )
      return false;
    this.#requestTimes.push(now);
    return true;
  }

  /** A device's ask goes to the broker; from anyone else it is refused. */
  async #device(message: ChannelMessage): Promise<void> {
    if (!isDeviceRequest(message) || this.#closed) return;
    if (!this.#devices) {
      this.#channel?.send({
        t: "dev.error",
        req: message.req,
        error: "access_denied",
      });
      return;
    }
    await this.#devices.handle(message);
  }

  async #answerFor(request: Request): Promise<string | null> {
    if (this.#closed || this.options.now() >= this.options.expiresAt)
      return null;
    if (this.options.kind === "device") return null;
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
    if (this.options.kind === "device") return null;
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
    this.#devices?.close();
    if (this.#grace) clearTimeout(this.#grace);
    this.#grace = null;
    this.#channel?.send({ t: "end" });
    this.#channel?.close();
    this.#relay?.close();
    this.#relay = null;
    this.#peer?.close();
  }
}
