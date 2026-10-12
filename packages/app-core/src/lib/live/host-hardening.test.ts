/**
 * The owner's side under a hostile or careless link holder (ADR 0150 §3):
 * an open session has no code to guess, a locked invite session keeps the
 * people already in, one admit is one peer whatever races it, and a seat that
 * never finishes does not sit there for ever.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveGuest } from "./guest.js";
import {
  type Admission,
  LiveHost,
  MAX_GUESTS,
  MAX_MISSES,
  SEAT_GRACE_MS,
} from "./host.js";
import { FAKE_CLOCK, deferred, settle } from "./live-clock.fixture.js";
import { FakeNet } from "./live-fakes.js";
import type { Catalog } from "./messages.js";
import { PAIRING_MS } from "./p2p.js";

const SECRET_VALUE = "correct horse battery staple";
const WRONG = "BCDF-GHJK";

const catalog: Catalog = {
  title: "Team vault",
  policy: "read",
  expiresAt: Date.now() + 8 * 60 * 60_000,
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
const guests: LiveGuest[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.end();
  for (const guest of guests.splice(0)) guest.leave();
  vi.useRealTimers();
});

async function open(admission: Admission, net = new FakeNet()) {
  const host = await LiveHost.start({
    admission,
    expiresAt: Date.now() + 8 * 60 * 60_000,
    catalog: () => catalog,
    readField: async () => SECRET_VALUE,
    transport: net.transport(),
  });
  hosts.push(host);
  return { net, host };
}

function joiner(
  net: FakeNet,
  host: LiveHost,
  code: string | null,
  name = "Ada",
): LiveGuest {
  const guest = new LiveGuest({
    link: host.link,
    code,
    name,
    note: "",
    transport: net.transport(),
  });
  guests.push(guest);
  return guest;
}
/** The joiner's request in, the owner's reply back: a guest in the session. */
async function join(net: FakeNet, host: LiveHost, guest: LiveGuest) {
  const received = await host.receive(await guest.start());
  if (received.kind !== "guest") throw new Error(received.kind);
  await host.admit(received.key);
  const reply = host.state.guests.find((g) => g.key === received.key)?.reply;
  expect(await guest.accept(reply ?? "")).toBe(true);
  await settle();
  return received.key;
}

describe("an open session has no code to guess", () => {
  it("survives any number of requests carrying a code nobody asked for", async () => {
    const { net, host } = await open("open");
    for (let attempt = 0; attempt < MAX_MISSES * 2; attempt += 1) {
      const request = await joiner(net, host, WRONG, `x${attempt}`).start();
      expect(await host.receive(request)).toEqual({ kind: "not-a-request" });
    }
    expect(host.state).toMatchObject({
      status: "live",
      misses: 0,
      locked: false,
    });
    // A legitimate guest still gets in, and is not thrown out by the noise.
    const ada = joiner(net, host, null);
    await join(net, host, ada);
    expect(ada.status.at).toBe("joined");
    expect(host.state.status).toBe("live");
  });
});

describe("an invite session locks on the fifth miss", () => {
  async function locked() {
    const { net, host } = await open("invite");
    const ada = joiner(net, host, host.code, "Ada");
    const inKey = await join(net, host, ada);
    // A second person asks, and waits for the owner.
    const waiting = joiner(net, host, host.code, "Waiting");
    const waitingRequest = await waiting.start();
    const waitingReceived = await host.receive(waitingRequest);
    for (let miss = 0; miss < MAX_MISSES; miss += 1)
      await host.receive(await joiner(net, host, WRONG + miss, "m").start());
    return { net, host, ada, inKey, waiting, waitingRequest, waitingReceived };
  }

  it("takes no new request, and nobody already in or asking is put out", async () => {
    const { net, host, ada, waiting, waitingReceived } = await locked();
    expect(host.state).toMatchObject({ status: "live", locked: true });
    // Neither the right code nor a wrong one is taken any more.
    const late = await joiner(net, host, host.code, "Late").start();
    expect(await host.receive(late)).toEqual({ kind: "locked" });
    const wrong = await joiner(net, host, "ZZZZ-ZZZZ", "Wrong").start();
    expect(await host.receive(wrong)).toEqual({ kind: "locked" });
    expect(host.state.misses).toBe(MAX_MISSES);
    // The guest in still works; the one waiting can still be let in.
    expect(ada.status.at).toBe("joined");
    expect(await ada.request("reveal", "item-1", "password")).toBe(
      SECRET_VALUE,
    );
    const key = waitingReceived.kind === "guest" ? waitingReceived.key : "";
    await host.admit(key);
    const reply = host.state.guests.find((g) => g.key === key)?.reply ?? "";
    expect(await waiting.accept(reply)).toBe(true);
    await settle();
    expect(waiting.status.at).toBe("joined");
    expect(host.state.status).toBe("live");
  });

  it("still hands a known request its reply again, and the owner can end it", async () => {
    const posted: string[] = [];
    const net = new FakeNet();
    const host = await LiveHost.start({
      admission: "invite",
      expiresAt: Date.now() + 60_000,
      catalog: () => catalog,
      readField: async () => SECRET_VALUE,
      transport: net.transport(),
      post: (code) => posted.push(code),
    });
    hosts.push(host);
    const ada = joiner(net, host, host.code);
    const request = await ada.start();
    const received = await host.receive(request);
    if (received.kind === "guest") await host.admit(received.key);
    expect(posted).toHaveLength(1);
    for (let miss = 0; miss < MAX_MISSES; miss += 1)
      await host.receive(await joiner(net, host, WRONG + miss, "m").start());
    expect(host.state.locked).toBe(true);
    // A carrier dropped the reply, and the joiner asks again: same reply.
    expect(await host.receive(request)).toEqual(received);
    expect(posted).toHaveLength(2);
    host.end();
    expect(host.state).toMatchObject({
      status: "ended",
      endedBecause: "owner",
    });
  });
});

describe("one admit is one peer", () => {
  it("a second admit while the first waits on the browser does not make another", async () => {
    const { net, host } = await open("invite");
    const ada = joiner(net, host, host.code);
    const received = await host.receive(await ada.start());
    const key = received.kind === "guest" ? received.key : "";
    // The owner's browser is slow to answer; the button is pressed twice.
    const hold = deferred();
    net.holdAnswer = hold.promise;
    const first = host.admit(key);
    const second = host.admit(key);
    hold.release();
    await Promise.all([first, second]);
    await settle();
    const owners = net.peers.filter((peer) => peer.answering);
    expect(owners).toHaveLength(1);
    expect(host.state.guests[0]?.state).toBe("replied");
    const reply = host.state.guests[0]?.reply ?? "";
    expect(await ada.accept(reply)).toBe(true);
    await settle();
    expect(host.state.guests[0]?.state).toBe("joined");
    // Nothing closed behind a live guest's back.
    expect(owners.some((peer) => peer.closed)).toBe(false);
  });

  for (const how of ["refuse", "end"] as const)
    it(`${how} while the browser is still answering leaves no connection open`, async () => {
      const { net, host } = await open("invite");
      const ada = joiner(net, host, host.code);
      const received = await host.receive(await ada.start());
      const key = received.kind === "guest" ? received.key : "";
      const hold = deferred();
      net.holdAnswer = hold.promise;
      const admitting = host.admit(key);
      await settle();
      if (how === "refuse") host.refuse(key);
      else host.end();
      hold.release();
      await admitting;
      await settle();
      const owners = net.peers.filter((peer) => peer.answering);
      expect(owners).toHaveLength(1);
      expect(owners.every((peer) => peer.closed)).toBe(true);
      expect(host.state.guests[0]).toMatchObject({
        state: how === "refuse" ? "refused" : "gone",
        reply: null,
      });
    });
});

describe("a seat does not wait for ever", () => {
  async function timed(admission: Admission = "invite") {
    vi.useFakeTimers(FAKE_CLOCK);
    return open(admission);
  }

  async function tick(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("requests that never connect expire, freeing their seats, then are forgotten", async () => {
    const { net, host } = await timed();
    const requests: string[] = [];
    for (let seat = 0; seat < MAX_GUESTS; seat += 1) {
      const request = await joiner(net, host, host.code, `p${seat}`).start();
      requests.push(request);
      expect((await host.receive(request)).kind).toBe("guest");
    }
    const late = await joiner(net, host, host.code, "late").start();
    expect(await host.receive(late)).toEqual({ kind: "full" });
    await tick(PAIRING_MS);
    expect(host.state.guests.map((guest) => guest.state)).toEqual(
      Array(MAX_GUESTS).fill("gone"),
    );
    // The seats are free again while the expired ones are still listed.
    expect((await host.receive(late)).kind).toBe("guest");
    await tick(SEAT_GRACE_MS);
    expect(host.state.guests.map((guest) => guest.name)).toEqual(["late"]);
    // An expired request that is reposted is not seated a second time.
    expect(await host.receive(requests[0] ?? "")).toEqual({
      kind: "not-a-request",
    });
    expect(host.state.guests).toHaveLength(1);
  });

  it("a person let in who never connects expires; one who connected stays", async () => {
    const { net, host } = await timed();
    const stuck = joiner(net, host, host.code, "Stuck");
    const stuckKey = await host.receive(await stuck.start());
    if (stuckKey.kind === "guest") await host.admit(stuckKey.key);
    expect(host.state.guests[0]?.state).toBe("replied");
    const ada = joiner(net, host, host.code, "Ada");
    const inKey = await join(net, host, ada);
    await tick(PAIRING_MS + 1);
    const states = Object.fromEntries(
      host.state.guests.map((guest) => [guest.name, guest.state]),
    );
    expect(states).toEqual({ Stuck: "gone", Ada: "joined" });
    expect(host.state.guests.find((g) => g.key === inKey)?.reply).toBeNull();
  });

  it("a guest who left and a person turned away are forgotten; a vanished seat is a no-op", async () => {
    const { net, host } = await timed();
    const ada = joiner(net, host, host.code, "Ada");
    const adaKey = await join(net, host, ada);
    const turned = await host.receive(
      await joiner(net, host, host.code, "Turned").start(),
    );
    const turnedKey = turned.kind === "guest" ? turned.key : "";
    host.refuse(turnedKey);
    ada.leave();
    await tick(10);
    expect(host.state.guests.map((guest) => guest.state)).toEqual([
      "gone",
      "refused",
    ]);
    await tick(SEAT_GRACE_MS);
    expect(host.state.guests).toEqual([]);
    // What the screen may still hold a key for does nothing, and throws nothing.
    await host.admit(adaKey);
    host.refuse(turnedKey);
    expect(host.state.guests).toEqual([]);
    expect(host.state.status).toBe("live");
  });

  it("ending the session stops every seat's clock", async () => {
    const { net, host } = await timed();
    const ada = joiner(net, host, host.code);
    await host.receive(await ada.start());
    ada.leave();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    host.end();
    expect(vi.getTimerCount()).toBe(0);
  });
});
