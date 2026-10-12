/**
 * The catalog handshake (ADR 0186), over a transport with no WebRTC in it.
 *
 * The stall this replaces: the owner sent the catalog once, the moment its
 * end of the channel opened; Chromium can drop exactly that frame, and the
 * joiner waited on "Connecting" with an open channel while the owner counted
 * them in. Here the transport drops that frame on purpose.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GREETINGS_MAX, GREETING_MS, Greeter } from "./greeting.js";
import { CONNECTING_TIMEOUT_MS, LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { FAKE_CLOCK, settle } from "./live-clock.fixture.js";
import type { Catalog } from "./messages.js";
import { MemoryNet } from "./p2p-fakes.js";
import { makeRequestCode, openReplyCode } from "./pairing.js";
import { newKeypair, newRequestId } from "./seal.js";

const SECRET = "correct horse battery staple";

const CATALOG: Catalog = {
  title: "Team",
  policy: "read",
  expiresAt: Date.now() + 3_600_000,
  items: [
    {
      id: "item-1",
      name: "GitHub",
      type: "account",
      fields: [
        { key: "password", label: "Password", concealed: true, value: null },
      ],
    },
  ],
};

const hosts: LiveHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.end();
  vi.useRealTimers();
});

async function room() {
  const net = new MemoryNet();
  const host = await LiveHost.start({
    admission: "invite",
    expiresAt: Date.now() + 3_600_000,
    catalog: () => CATALOG,
    readField: async (item, field) =>
      item === "item-1" && field === "password" ? SECRET : null,
    transport: net.transport(),
  });
  hosts.push(host);
  const guest = new LiveGuest({
    link: host.link,
    code: host.code,
    name: "Ada",
    note: "",
    transport: net.transport(),
  });
  return { net, host, guest };
}

/** Ask, let in, and hand the reply back, as two people would. */
async function pair(host: LiveHost, request: string, guest: LiveGuest) {
  const received = await host.receive(request);
  if (received.kind !== "guest") throw new Error(received.kind);
  await host.admit(received.key);
  const reply = host.state.guests.find((g) => g.key === received.key)?.reply;
  expect(await guest.accept(reply ?? "")).toBe(true);
  return received.key;
}

const seat = (host: LiveHost, key: string) =>
  host.state.guests.find((guest) => guest.key === key)?.state;

describe("a live session over a transport that is not WebRTC", () => {
  it("pairs, joins and reveals one value", async () => {
    const { host, guest } = await room();
    const key = await pair(host, await guest.start(), guest);
    await settle();
    expect(guest.status).toEqual({ at: "joined", catalog: CATALOG });
    expect(seat(host, key)).toBe("joined");
    expect(await guest.request("reveal", "item-1", "password")).toBe(SECRET);
  });
});

describe("the catalog handshake", () => {
  it("joins although the owner's first frame is lost", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const { net, host, guest } = await room();
    net.losing.owner = 1;
    await pair(host, await guest.start(), guest);
    await settle();
    expect(guest.status.at).toBe("connecting");
    await vi.advanceTimersByTimeAsync(GREETING_MS[0] ?? 0);
    await settle();
    // Lost once, sent again for the next greeting, and the session stands.
    expect(net.sent.filter((f) => f.message.t === "catalog")).toHaveLength(2);
    expect(guest.status.at).toBe("joined");
  });

  it("joins although the joiner's first greeting is lost", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const { net, host, guest } = await room();
    net.losing.joiner = 1;
    const key = await pair(host, await guest.start(), guest);
    await settle();
    expect(guest.status.at).toBe("connecting");
    expect(seat(host, key)).toBe("replied");
    await vi.advanceTimersByTimeAsync(GREETING_MS[0] ?? 0);
    await settle();
    expect(guest.status.at).toBe("joined");
    expect(seat(host, key)).toBe("joined");
  });

  it("counts a guest in only once it has been heard from", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const { net, host, guest } = await room();
    net.losing.joiner = Number.POSITIVE_INFINITY;
    const key = await pair(host, await guest.start(), guest);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    // The channel is open, but nothing from the guest ever arrived.
    expect(net.sent.some((f) => f.side === "owner")).toBe(false);
    expect(seat(host, key)).toBe("replied");
    expect(guest.status.at).toBe("connecting");
  });

  it("gives up at the connect timeout, and the owner sees the seat go", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const { net, host, guest } = await room();
    net.losing.owner = Number.POSITIVE_INFINITY;
    const key = await pair(host, await guest.start(), guest);
    await settle();
    expect(seat(host, key)).toBe("joined");
    await vi.advanceTimersByTimeAsync(CONNECTING_TIMEOUT_MS);
    await settle();
    expect(guest.status.at).toBe("connect_timeout");
    expect(seat(host, key)).toBe("gone");
    // Nothing goes on greeting once the attempt is over.
    const greetings = net.sent.filter((f) => f.message.t === "hello").length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(net.sent.filter((f) => f.message.t === "hello")).toHaveLength(
      greetings,
    );
  });

  it("asks again after a timeout with a fresh request, which joins", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const { net, host, guest } = await room();
    net.losing.owner = Number.POSITIVE_INFINITY;
    const first = await guest.start();
    await pair(host, first, guest);
    await vi.advanceTimersByTimeAsync(CONNECTING_TIMEOUT_MS);
    await settle();
    expect(guest.status.at).toBe("connect_timeout");
    net.losing.owner = 0;
    const again = await guest.askAgain();
    expect(again).not.toBe(first);
    expect(guest.status).toEqual({ at: "request", code: again });
    const key = await pair(host, again, guest);
    await settle();
    expect(guest.status.at).toBe("joined");
    expect(seat(host, key)).toBe("joined");
  });
});

describe("a joiner from before greetings", () => {
  it("is sent the catalog unasked and counted in at once", async () => {
    const { net, host } = await room();
    const keys = await newKeypair();
    const transport = net.transport();
    const dialed = await transport.dial();
    const id = newRequestId();
    const request = await makeRequestCode(host.link, host.code, keys, {
      id,
      name: "Old build",
      note: "",
      offer: dialed.handshake,
      greets: false,
    });
    const received = await host.receive(request);
    if (received.kind !== "guest") throw new Error(received.kind);
    await host.admit(received.key);
    const replyCode = host.state.guests[0]?.reply ?? "";
    const reply = await openReplyCode(
      host.link,
      host.code,
      keys,
      id,
      replyCode,
      transport.readsAnswer,
    );
    const heard: string[] = [];
    dialed.channel.then((channel) =>
      channel.onMessage((message) => heard.push(message.t)),
    );
    await dialed.accept(reply?.answer ?? "");
    await settle();
    // It never said a word, and it is in, holding the catalog.
    expect(heard).toEqual(["catalog"]);
    expect(seat(host, received.key)).toBe("joined");
    dialed.close();
  });
});

describe("the owner's answers", () => {
  it("are bounded however often a guest greets", async () => {
    const { net, host, guest } = await room();
    await pair(host, await guest.start(), guest);
    await settle();
    const channel = await net.links[0]?.channel;
    for (let i = 0; i < GREETINGS_MAX * 2; i += 1)
      channel?.send({ t: "hello" });
    await settle();
    expect(
      net.sent.filter((f) => f.side === "owner" && f.message.t === "catalog"),
    ).toHaveLength(GREETINGS_MAX);
  });
});

describe("a greeter", () => {
  it("greets now, backs off, and stops when told or when a greeting fails", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    const greeter = new Greeter();
    let sent = 0;
    greeter.start(() => {
      sent += 1;
      return sent < 4;
    });
    expect(sent).toBe(1);
    await vi.advanceTimersByTimeAsync(GREETING_MS[0] ?? 0);
    expect(sent).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    // The fourth greeting failed, and nothing was tried after it.
    expect(sent).toBe(4);
    greeter.start(() => true);
    greeter.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
