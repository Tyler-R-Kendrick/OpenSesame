/**
 * The owner's addresses wait for the joiner (ADR 0150 §6, amended
 * 2026-10-24): a reply that names addresses is held, nothing is handed to
 * the transport, and no check can be made until the person allows them or
 * joins without them. Declining is not leaving: the join goes on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { settle } from "./live-clock.fixture.js";
import type { Catalog } from "./messages.js";
import { MemoryNet } from "./p2p-fakes.js";

const CATALOG: Catalog = {
  title: "Team",
  policy: "read",
  expiresAt: Date.now() + 3_600_000,
  items: [],
};

const hosts: LiveHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.end();
});

async function room(named: readonly string[]) {
  const net = new MemoryNet();
  net.named = named;
  const host = await LiveHost.start({
    admission: "invite",
    expiresAt: Date.now() + 3_600_000,
    catalog: () => CATALOG,
    readField: async () => null,
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
  const received = await host.receive(await guest.start());
  if (received.kind !== "guest") throw new Error(received.kind);
  await host.admit(received.key);
  const reply = host.state.guests.find((g) => g.key === received.key)?.reply;
  expect(await guest.accept(reply ?? "")).toBe(true);
  // The joiner dialed first: its link is the first the network made.
  const joiner = net.links[0];
  if (!joiner) throw new Error("no joiner link");
  return { guest, joiner };
}

describe("a reply that names the owner's addresses", () => {
  it("is held, with nothing handed to the transport, until the person allows them", async () => {
    const { guest, joiner } = await room(["100.64.0.7"]);
    expect(guest.status).toEqual({
      at: "addresses",
      addresses: ["100.64.0.7"],
    });
    await settle();
    expect(joiner.allowed).toBeNull();
    expect(await guest.allowAddresses(true)).toBe(true);
    expect(joiner.allowed).toEqual(["100.64.0.7"]);
    await settle();
    expect(guest.status.at).toBe("joined");
  });

  it("joins without them when the person declines", async () => {
    const { guest, joiner } = await room(["100.64.0.7", "127.0.0.1"]);
    expect(await guest.allowAddresses(false)).toBe(true);
    expect(joiner.allowed).toEqual([]);
    await settle();
    expect(guest.status.at).toBe("joined");
  });

  it("takes one answer: a second, or one after leaving, does nothing", async () => {
    const first = await room(["100.64.0.7"]);
    expect(await first.guest.allowAddresses(false)).toBe(true);
    expect(await first.guest.allowAddresses(true)).toBe(false);
    expect(first.joiner.allowed).toEqual([]);
    const left = await room(["100.64.0.7"]);
    left.guest.leave();
    expect(await left.guest.allowAddresses(true)).toBe(false);
    expect(left.joiner.allowed).toBeNull();
  });

  it("goes straight on when the reply names none", async () => {
    const { guest, joiner } = await room([]);
    expect(guest.status.at).not.toBe("addresses");
    expect(joiner.allowed).toEqual([]);
    expect(await guest.allowAddresses(true)).toBe(false);
  });
});
