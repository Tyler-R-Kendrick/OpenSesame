/**
 * A session carried over a NATS carrier (ADR 0167): when the browsers find
 * no route to each other — or always, if the owner said so — the seat moves
 * onto the carrier, sealed end to end, and works as it does over WebRTC. A
 * carrier that may carry codes only does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainAccount } from "../account.test-support.js";
import { FALLBACK_MS } from "./guest.js";
import { RELAY_GRACE_MS } from "./host-peer.js";
import { FAKE_CLOCK, settle } from "./live-clock.fixture.js";
import { FakeBus, FakeNet } from "./live-fakes.js";
import type { NatsSession } from "./nats-route.js";
import type { Carrier } from "./rendezvous.js";
import { newKeypair, newLinkSecret } from "./seal.js";
import { SeatChannel } from "./seat-channel.js";
import {
  endHosting,
  joinLive,
  leaveLive,
  liveSeams,
  startHosting,
} from "./session.js";
import type { LiveTransport } from "./transport.js";

const SECRET_VALUE = "correct horse battery staple";
const github = plainAccount("GitHub", SECRET_VALUE);

const original = { items: liveSeams.items, onLock: liveSeams.onLock };
beforeEach(() => {
  liveSeams.items = () => [github];
  liveSeams.onLock = () => () => undefined;
});
afterEach(() => {
  vi.useRealTimers();
  endHosting();
  leaveLive();
  liveSeams.items = original.items;
  liveSeams.onLock = original.onLock;
});

function profile(session?: NatsSession): LiveTransport {
  return {
    addresses: [],
    ice: [],
    relay: false,
    carriers: [
      session
        ? { kind: "nats", url: "wss://nats.example.test", session }
        : { kind: "nats", url: "wss://nats.example.test" },
    ],
  };
}

async function session(net: FakeNet, bus: FakeBus, transport: LiveTransport) {
  const owner = await startHosting({
    title: "Team",
    scope: { kind: "vault" },
    policy: "read",
    admission: "invite",
    minutes: 30,
    transport: net.transports(),
    routes: transport,
    carriers: bus.factory(),
  });
  await settle();
  const guest = await joinLive({
    link: owner.link,
    code: owner.code,
    name: "Ada",
    note: "",
    transport: net.transports(),
    useRoutes: true,
    carriers: bus.factory(),
  });
  await settle();
  await owner.admit(owner.state.guests[0]?.key ?? "");
  for (let i = 0; i < 20 && guest.status.at !== "joined"; i += 1)
    await settle();
  return { owner, guest };
}

function seatFrames(bus: FakeBus): string[] {
  return bus.seen
    .filter(({ topic }) => topic.includes(".seat."))
    .map(({ frame }) => frame);
}

describe("a NATS carrier that may carry the session", () => {
  it("carries it when the browsers cannot reach each other, sealed end to end", async () => {
    const net = new FakeNet();
    net.unreachable = true;
    const bus = new FakeBus();
    const { owner, guest } = await session(net, bus, profile());
    expect(guest.status.at).toBe("joined");
    expect(owner.state.guests[0]?.state).toBe("joined");
    const item =
      guest.status.at === "joined" ? guest.status.catalog.items[0] : undefined;
    const field = item?.fields.find((entry) => entry.concealed);
    const value = await guest.request(
      "reveal",
      item?.id ?? "",
      field?.key ?? "",
    );
    expect(value).toBe(SECRET_VALUE);
    const frames = seatFrames(bus);
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames) {
      expect(frame).not.toContain(SECRET_VALUE);
      expect(frame).not.toContain("GitHub");
    }
  });

  it("stays on the peer route when there is one", async () => {
    const net = new FakeNet();
    const bus = new FakeBus();
    const { guest } = await session(net, bus, profile());
    expect(guest.status.at).toBe("joined");
    expect(seatFrames(bus)).toEqual([]);
  });

  it("is used from the start when the owner says always", async () => {
    const net = new FakeNet();
    const bus = new FakeBus();
    const { guest } = await session(net, bus, profile("always"));
    expect(guest.status.at).toBe("joined");
    expect(seatFrames(bus).length).toBeGreaterThan(0);
  });

  it("lets a seat go when the joiner never reaches the relay either", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const net = new FakeNet();
    net.unreachable = true;
    const bus = new FakeBus();
    bus.blockSeats = true;
    const { owner, guest } = await session(net, bus, profile());
    expect(guest.status.at).not.toBe("joined");
    await vi.advanceTimersByTimeAsync(FALLBACK_MS);
    await settle();
    // No peer route and nothing heard on the relay: the seat waits a while.
    expect(owner.state.guests[0]?.state).toBe("replied");
    await vi.advanceTimersByTimeAsync(RELAY_GRACE_MS - FALLBACK_MS);
    await settle();
    expect(owner.state.guests[0]?.state ?? "gone").toBe("gone");
  });

  it("carries codes only when the owner says off: no route is no session", async () => {
    const net = new FakeNet();
    net.unreachable = true;
    const bus = new FakeBus();
    const { guest } = await session(net, bus, profile("off"));
    expect(guest.status.at).toBe("unreachable");
    expect(seatFrames(bus)).toEqual([]);
  });
});

/** Two ends of one seat on a shared in-memory subject. */
async function seat() {
  const bus = new FakeBus();
  const factory = bus.factory();
  const carrier = async (): Promise<Carrier> => {
    const opened = await factory(
      { kind: "nats", url: "wss://nats.example.test" },
      "T",
    );
    if (!opened.channel) throw new Error("no channels");
    return opened.channel("seat.R");
  };
  const owner = await newKeypair();
  const joiner = await newKeypair();
  const shared = await owner.shared(joiner.pub);
  if (!shared) throw new Error("ecdh");
  const keys = {
    link: {
      admission: "invite" as const,
      owner: owner.pub,
      secret: newLinkSecret(),
      routes: null,
    },
    code: "BCDF-GHJK",
    joiner: joiner.pub,
    id: "R",
    shared,
  };
  return {
    bus,
    keys,
    host: new SeatChannel(await carrier(), keys, "owner"),
    guest: new SeatChannel(await carrier(), keys, "joiner"),
    carrier,
  };
}

describe("a seat's channel", () => {
  it("delivers both ways in order, and an end closes the other side", async () => {
    const { host, guest } = await seat();
    const heard: string[] = [];
    host.onMessage((message) => heard.push(message.t));
    let closed = false;
    host.onClose(() => {
      closed = true;
    });
    guest.send({ t: "hello" });
    guest.send({ t: "reveal", req: "r1", item: "i", field: "f" });
    await settle();
    expect(heard).toEqual(["hello", "reveal"]);
    guest.close();
    await settle();
    expect(closed).toBe(true);
  });

  it("drops a replayed frame, a forged one, and one from another seat", async () => {
    const { bus, host, guest, keys, carrier } = await seat();
    const heard: string[] = [];
    host.onMessage((message) => heard.push(message.t));
    guest.send({ t: "hello" });
    await settle();
    const first = bus.seen.find(({ frame }) => frame.startsWith("osc1.g."));
    expect(first).toBeDefined();
    // Replayed as it was, and with a later sequence number.
    bus.inject(first?.topic ?? "", first?.frame ?? "");
    bus.inject(
      first?.topic ?? "",
      (first?.frame ?? "").replace("osc1.g.1.", "osc1.g.9."),
    );
    // Sealed for another seat (another request id).
    const other = new SeatChannel(
      await carrier(),
      { ...keys, id: "S" },
      "joiner",
    );
    other.send({ t: "hello" });
    await settle();
    expect(heard).toEqual(["hello"]);
  });

  it("refuses a frame heavier than a peer message may be", async () => {
    const { guest } = await seat();
    expect(
      guest.send({
        t: "edit",
        req: "r1",
        item: "i",
        field: "f",
        value: "x".repeat(300_000),
      }),
    ).toBe(false);
  });
});
