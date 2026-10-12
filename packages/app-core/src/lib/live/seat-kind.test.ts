/**
 * Who is asking, and how they will arrive (ADR 0195): a request names a seat
 * kind and a route, read as strictly as the rest of the pairing, and the owner
 * seats only what it can serve.
 */
import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceBroker } from "./device-broker.js";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { settle } from "./live-clock.fixture.js";
import { FakeNet, fakeSdp } from "./live-fakes.js";
import {
  type JoinRequest,
  readJoinReply,
  readJoinRequest,
} from "./messages.js";
import { makeRequestCode } from "./pairing.js";
import { newKeypair, newRequestId } from "./seal.js";

const ID = "A".repeat(22);
const reads = (handshake: string) => handshake === fakeSdp("fake-1");
const request = (extra: JsonObject) =>
  JSON.stringify({
    id: ID,
    name: "laptop",
    note: "",
    offer: fakeSdp("fake-1"),
    greets: true,
    ...extra,
  });

describe("a request's kind and route", () => {
  it("reads an ordinary request as a person on a peer route", () => {
    expect(readJoinRequest(request({}), reads)).toMatchObject({
      kind: "person",
      route: "peer",
    });
  });

  it("reads a device, and a relay-only request that carries no offer", () => {
    expect(readJoinRequest(request({ kind: "device" }), reads)).toMatchObject({
      kind: "device",
      route: "peer",
    });
    const bare = { route: "relay", kind: "device", offer: undefined };
    expect(readJoinRequest(request(bare), reads)).toMatchObject({
      kind: "device",
      route: "relay",
      offer: "",
    });
    expect(
      readJoinRequest(request({ ...bare, offer: "" }), reads),
    ).toMatchObject({ route: "relay", offer: "" });
  });

  it("refuses a relay-only request that also carries an offer", () => {
    expect(readJoinRequest(request({ route: "relay" }), reads)).toBeNull();
  });

  it("refuses a peer request with no offer, and kinds and routes nobody has met", () => {
    expect(readJoinRequest(request({ offer: "" }), reads)).toBeNull();
    expect(readJoinRequest(request({ kind: "admin" }), reads)).toBeNull();
    expect(readJoinRequest(request({ kind: 1 }), reads)).toBeNull();
    expect(readJoinRequest(request({ route: "tor" }), reads)).toBeNull();
    expect(readJoinRequest(request({ route: ["relay"] }), reads)).toBeNull();
  });
});

describe("a reply with no answer", () => {
  const reply = (body: JsonObject) =>
    JSON.stringify({ id: ID, answer: fakeSdp("fake-1"), ...body });

  it("is the owner's word that the relay carries the seat", () => {
    expect(readJoinReply(reply({ answer: "", relay: "nats" }), reads)).toEqual({
      id: ID,
      answer: "",
      relay: "nats",
    });
    expect(readJoinReply(reply({ answer: "" }), reads)).toBeNull();
  });

  it("still reads an ordinary reply, with or without a relay", () => {
    expect(readJoinReply(reply({}), reads)).toEqual({
      id: ID,
      answer: fakeSdp("fake-1"),
    });
    expect(readJoinReply(reply({ relay: "nats" }), reads)).toMatchObject({
      relay: "nats",
    });
    expect(readJoinReply(reply({ relay: "mqtt" }), reads)).toBeNull();
  });
});

const hosts: LiveHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.end();
});

/** What a session in these walks offers: devices, and a relay to carry one. */
type Offering = Readonly<{ devices?: boolean; canRelay?: boolean }>;

async function open(options: Offering) {
  const net = new FakeNet();
  const host = await LiveHost.start({
    admission: "open",
    expiresAt: Date.now() + 60 * 60_000,
    catalog: () => ({
      title: "Team",
      policy: "read",
      expiresAt: Date.now() + 60_000,
      items: [],
    }),
    readField: async () => null,
    transport: net.transport(),
    canRelay: () => options.canRelay ?? false,
    devices: options.devices
      ? {
          port: () => ({
            list: () => [],
            invoke: async () => ({ label: "", items: [] }),
          }),
        }
      : undefined,
  });
  hosts.push(host);
  return { host, net };
}

async function asked(
  host: LiveHost,
  seat: Pick<JoinRequest, "kind" | "route">,
) {
  const joiner = await newKeypair();
  const code = await makeRequestCode(host.link, host.code, joiner, {
    id: newRequestId(),
    name: "laptop",
    note: "",
    offer: "",
    greets: true,
    ...seat,
  });
  return host.receive(code);
}

describe("what the owner will seat", () => {
  it("turns a device away where devices may not ask", async () => {
    const { host } = await open({ canRelay: true });
    expect(await asked(host, { kind: "device", route: "relay" })).toEqual({
      kind: "no-devices",
    });
    expect(host.state.guests).toEqual([]);
  });

  it("turns a relay-only request away where no relay could carry it", async () => {
    const { host } = await open({ devices: true });
    expect(await asked(host, { kind: "device", route: "relay" })).toEqual({
      kind: "no-relay",
    });
    expect(host.state.guests).toEqual([]);
  });

  it("seats a device as a device, and a person as a person", async () => {
    const { host, net } = await open({ devices: true, canRelay: true });
    const device = await asked(host, { kind: "device", route: "relay" });
    expect(device.kind).toBe("guest");
    expect(host.state.guests[0]).toMatchObject({ kind: "device" });
    const guest = new LiveGuest({
      link: host.link,
      code: host.code,
      name: "Ada",
      note: "",
      transport: net.transport(),
    });
    const received = await host.receive(await guest.start());
    expect(received.kind).toBe("guest");
    await settle();
    expect(host.state.guests.map((seat) => seat.kind).sort()).toEqual([
      "device",
      "person",
    ]);
    guest.leave();
  });

  it("starts a session with a broker only when devices may ask", async () => {
    expect((await open({ devices: true })).host.devices).toBeInstanceOf(
      DeviceBroker,
    );
    expect((await open({})).host.devices).toBeNull();
  });

  it("drops a relay-only seat whose relay went away before the owner let it in", async () => {
    const { host } = await open({ devices: true, canRelay: true });
    const device = await asked(host, { kind: "device", route: "relay" });
    // No relay option is wired in this host: admitting finds none to carry it.
    await host.admit(device.kind === "guest" ? device.key : "");
    await settle();
    expect(host.state.guests[0]?.state).toBe("gone");
  });
});
