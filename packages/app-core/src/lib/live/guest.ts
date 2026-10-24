/** The joiner's side of a live session (ADR 0150, ADR 0186). */

import type { SessionBinding } from "../peer-trust/handshake.js";
import { type ChannelRequest, ChannelRequests } from "./channel-requests.js";
import {
  type DeviceMessage,
  type DeviceRequest,
  isDeviceMessage,
} from "./device-messages.js";
import { Greeter } from "./greeting.js";
import { GuestIce } from "./guest-ice.js";
import { makeJoinRequestCode } from "./guest-request.js";
import {
  CONNECTING_TIMEOUT_MS,
  FALLBACK_MS,
  type GuestOptions,
  type GuestStatus,
} from "./guest-types.js";
import {
  type Catalog,
  type ChannelMessage,
  type JoinReply,
  VALUE_MAX,
  characters,
  cleanText,
} from "./messages.js";
import {
  DIRECT_ROUTING,
  type DialLink,
  type LiveChannel,
  dialForRoute,
} from "./p2p.js";
import { openReplyCode } from "./pairing.js";
import {
  replyHonorsPeer,
  requestView,
  sealRequestPeer,
} from "./peer-trust-join.js";
import { RequestPosts } from "./repost.js";
import { type Keypair, newKeypair, newRequestId } from "./seal.js";
import { SeatChannel, seatName } from "./seat-channel.js";
import { TimerSlot } from "./timer-slot.js";

export { CONNECTING_TIMEOUT_MS, FALLBACK_MS } from "./guest-types.js";
export type * from "./guest-types.js";

export class LiveGuest {
  readonly #listeners = new Set<(status: GuestStatus) => void>();
  readonly #requests = new ChannelRequests();
  readonly #greeter = new Greeter();
  /** The request this attempt made; a fresh one when the person asks again. */
  #id = newRequestId();
  #status: GuestStatus = { at: "preparing" };
  #peer: DialLink | null = null;
  #channel: LiveChannel | null = null;
  /** The owner offered a relay: the carriers stay open with the seat. */
  #relayed = false;
  readonly #fallback = new TimerSlot();
  readonly #connectTimer = new TimerSlot();
  #keys: Keypair | null = null;
  #bound: SessionBinding | null = null;
  #trustedOwner: { fingerprint: string; epoch: number } | null = null;
  readonly #posts: RequestPosts;
  #device: ((message: DeviceMessage) => void) | null = null;
  #farewell: Promise<void> = Promise.resolve();
  readonly #ice: GuestIce;
  /** A reply whose addresses wait for the person to allow (ADR 0150 §6). */
  #held: { peer: DialLink; reply: JoinReply } | null = null;

  constructor(private readonly options: GuestOptions) {
    this.#posts = new RequestPosts(options.carriers);
    this.#ice = new GuestIce(
      options.routing ?? DIRECT_ROUTING,
      options.now ?? Date.now,
    );
  }

  get status(): GuestStatus {
    return this.#status;
  }

  trustedOwner(): { fingerprint: string; epoch: number } | null {
    return this.#trustedOwner;
  }

  subscribe(listener: (status: GuestStatus) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#status);
    return () => this.#listeners.delete(listener);
  }

  #to(status: GuestStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  async start(): Promise<string> {
    // The owner reads these cleaned (`readJoinRequest`); say the same here.
    if (!cleanText(this.options.name)) throw new Error("join_name_required");
    this.#keys = await newKeypair();
    return this.#ask();
  }

  /** After a connect timeout: a fresh request, for the owner to let in. */
  async askAgain(): Promise<string> {
    if (this.#status.at !== "connect_timeout") return "";
    this.#id = newRequestId();
    this.#to({ at: "preparing" });
    try {
      return await this.#ask();
    } catch (error) {
      this.#finish();
      throw error;
    }
  }

  async #ask(): Promise<string> {
    const { link, code, name, note, kind, route, transport } = this.options;
    const keys = this.#keys;
    if (!keys) return "";
    const peer = await dialForRoute(route, transport);
    if (this.#over()) {
      // Left while the transport was dialing: `#finish` found no link.
      peer?.channel.catch(() => undefined);
      peer?.close();
      return "";
    }
    this.#peer = peer;
    const sealed = await sealRequestPeer(
      this.options.peerTrust,
      peer?.handshake ?? "",
    );
    if (!sealed.ok) {
      peer?.close();
      throw new Error("peer_trust_refused:invalid-signal");
    }
    peer?.channel.then(
      (channel) => {
        if (this.#peer === peer) this.#connected(channel);
        else channel.close();
      },
      () => {
        if (this.#peer === peer && !this.#relayed) this.#finish();
      },
    );
    const request = await makeJoinRequestCode(
      link,
      code,
      keys,
      { id: this.#id, name, note, offer: peer?.handshake ?? "", kind, route },
      sealed.peer,
    );
    if (this.#status.at === "preparing") {
      this.#bound = sealed.binding;
      this.#trustedOwner = sealed.owner;
      this.#to(requestView(request, sealed.sas, sealed.unverified));
      this.#posts.carry(request, () => this.#status.at === "request");
    }
    return request;
  }

  async accept(text: string): Promise<boolean> {
    const keys = this.#keys;
    const peer = this.#peer;
    const relayOnly = this.options.route === "relay";
    if (this.#status.at !== "request" || !keys) return false;
    if (!peer && !relayOnly) return false;
    const { link, code, transport } = this.options;
    const reply = await openReplyCode(
      link,
      code,
      keys,
      this.#id,
      text,
      transport?.readsAnswer ?? (() => false),
    );
    if (!reply || this.#status.at !== "request" || this.#peer !== peer)
      return false;
    // A relay-only request is answered by the relay or not at all; and an
    // answer-less reply is no answer to one that offered a peer route.
    if (relayOnly !== (reply.answer === "")) return false;
    if (this.#bound && !(await replyHonorsPeer(this.#bound, reply)))
      return false;
    return this.#hold(peer, reply);
  }

  async #hold(peer: DialLink | null, reply: JoinReply): Promise<boolean> {
    if (!peer || !reply.addresses?.length)
      return this.#connectWithReply(peer, reply, []);
    // The owner's seal says who named these, not that this browser may check
    // them: nothing is checked until the person decides (ADR 0150 §6).
    this.#held = { peer, reply };
    this.#to({ at: "addresses", addresses: reply.addresses });
    return true;
  }

  /** The person's answer to the reply's addresses: allow them, or not. */
  async allowAddresses(allow: boolean): Promise<boolean> {
    const held = this.#held;
    this.#held = null;
    if (!held || this.#status.at !== "addresses") return false;
    const allowed = allow ? (held.reply.addresses ?? []) : [];
    return this.#connectWithReply(held.peer, held.reply, allowed);
  }

  async #connectWithReply(
    peer: DialLink | null,
    reply: JoinReply,
    allowed: readonly string[],
  ): Promise<boolean> {
    const session = this.options.carriers?.session ?? "off";
    this.#relayed = reply.relay === "nats" && session !== "off";
    if (!peer && !this.#relayed) {
      // Nothing to meet the owner over: this side has no peer route either.
      this.#finishUnreachable(false);
      return false;
    }
    // The carriers stay open until the catalog comes: asking again uses them.
    this.#posts.stop();
    this.#ice.begin(
      peer,
      (status) => this.#to(status),
      () => this.#status.at === "connecting",
    );
    this.#connectTimer.set(() => {
      if (this.#status.at === "connecting") this.#giveUp();
    }, CONNECTING_TIMEOUT_MS);
    if (!peer || (this.#relayed && session === "always")) {
      void this.#toRelay();
      return true;
    }
    peer.onFailed(() => {
      if (this.#status.at !== "connecting" || this.#peer !== peer) return;
      if (this.#relayed) void this.#toRelay();
      else this.#finishUnreachable(false);
    });
    if (this.#relayed)
      this.#fallback.set(() => void this.#toRelay(), FALLBACK_MS);
    try {
      await peer.accept(reply.answer, allowed);
      return true;
    } catch {
      this.#finish();
      return false;
    }
  }

  async #toRelay(): Promise<void> {
    this.#fallback.clear();
    const keys = this.#keys;
    if (this.#over() || this.#channel || !keys) return;
    const carrier = this.options.carriers?.seat?.(seatName(this.#id)) ?? null;
    const shared = await keys.shared(this.options.link.owner);
    if (!carrier || !shared) {
      carrier?.close();
      this.#finishUnreachable(false);
      return;
    }
    if (this.#over() || this.#channel) {
      carrier.close();
      return;
    }
    const peer = this.#peer;
    this.#peer = null;
    peer?.close();
    const seat = { link: this.options.link, code: this.options.code };
    this.#connected(
      new SeatChannel(
        carrier,
        { ...seat, joiner: keys.pub, id: this.#id, shared },
        "joiner",
      ),
    );
  }

  /** Over the transport or the relay: greet until the catalog arrives. */
  #connected(channel: LiveChannel): void {
    // Over already, or the seat is carried another way: not this channel.
    if (this.#over() || this.#channel) {
      channel.close();
      return;
    }
    this.#fallback.clear();
    this.#channel = channel;
    channel.onMessage((message) => this.#onMessage(message));
    channel.onClose(() => {
      if (this.#channel === channel) this.#finish();
    });
    this.#greeter.start(() => channel.send({ t: "hello" }));
  }

  #onMessage(message: ChannelMessage): void {
    if (message.t === "catalog") this.#joined(message.catalog);
    else if (message.t === "end") this.#finish();
    else if (message.t === "value" || message.t === "denied")
      this.#requests.answer(message);
    else if (isDeviceMessage(message)) this.#device?.(message);
  }

  /** Hear the owner's answers to a device's asks (ADR 0196). */
  onDevice(handler: (message: DeviceMessage) => void): void {
    this.#device = handler;
  }

  /** Send a device's ask; false unless in the session with the frame sent. */
  sendDevice(request: DeviceRequest): boolean {
    const channel = this.#channel;
    if (this.#status.at !== "joined" || !channel) return false;
    return channel.send(request);
  }

  /** The first catalog is the session; later ones replace what it shared. */
  #joined(catalog: Catalog): void {
    const first = this.#status.at === "connecting";
    if (!first && this.#status.at !== "joined") return;
    if (first) {
      this.#greeter.stop();
      this.#connectTimer.clear();
      this.#posts.release(this.#relayed);
    }
    this.#to({ at: "joined", catalog });
  }

  /** Replace one shared field. The saved text, or null if the owner refused. */
  edit(item: string, field: string, value: string): Promise<string | null> {
    if (characters(value) > VALUE_MAX) return Promise.resolve(null);
    return this.#call({ t: "edit", item, field, value });
  }

  /** One concealed value, to show (`reveal`) or to copy; null if refused. */
  request(
    what: "reveal" | "copy",
    item: string,
    field: string,
  ): Promise<string | null> {
    return this.#call({ t: what, item, field });
  }

  /** Only in the session: before or after it, every request is refused. */
  #call(request: ChannelRequest): Promise<string | null> {
    const channel = this.#channel;
    if (this.#status.at !== "joined" || !channel) return Promise.resolve(null);
    return this.#requests.call(channel, request);
  }

  #over(): boolean {
    return this.#status.at === "ended" || this.#status.at === "unreachable";
  }

  /** Close this attempt's link and channel; the carriers are another matter. */
  #drop(): Promise<void> | null {
    this.#held = null;
    this.#greeter.stop();
    this.#connectTimer.clear();
    this.#fallback.clear();
    this.#requests.drop();
    const channel = this.#channel;
    const peer = this.#peer;
    this.#channel = null;
    this.#peer = null;
    channel?.close();
    const farewell = channel?.drained?.() ?? null;
    if (farewell) this.#farewell = farewell;
    peer?.close();
    return farewell;
  }

  /** No catalog in time: this attempt is over, and the owner sees it go. */
  #giveUp(): void {
    this.#relayed = false;
    this.#drop();
    this.#to({ at: "connect_timeout" });
  }

  #finishUnreachable(timedOut: boolean): void {
    this.#finish({ at: "unreachable", reason: this.#ice.reason(timedOut) });
  }

  #finish(end: GuestStatus = { at: "ended" }): void {
    if (this.#over()) return;
    this.#relayed = false;
    this.#ice.stop();
    // The goodbye is posted first and the carriers let go after it.
    this.#posts.release(this.#relayed, this.#drop());
    // The catalog goes with the status it rode on.
    this.#to(end);
  }

  /** After a leave: the goodbye is out, so the carriers may be closed. */
  left(): Promise<void> {
    return this.#farewell;
  }

  /** Leave, dropping everything held; the owner sees the channel close. */
  leave(): void {
    this.#finish();
  }
}
