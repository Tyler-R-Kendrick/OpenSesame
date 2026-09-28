/**
 * Carriers passing the pairing codes (ADR 0150 §6): the frames, and a whole
 * session paired with nobody pasting anything — over a fake carrier service
 * that anyone may post junk to.
 */
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveHost } from "./host.js";
import { FakeBus, FakeNet } from "./live-fakes.js";
import { makeRequestCode } from "./pairing.js";
import { Reassembler, carrierTopic, toFrames } from "./rendezvous.js";
import { newKeypair, newRequestId } from "./seal.js";
import {
  currentGuest,
  currentHostCarriers,
  endHosting,
  joinLive,
  leaveLive,
  liveSeams,
  startHosting,
} from "./session.js";
import type { LiveTransport } from "./transport.js";

const SECRET = "correct horse battery staple";
const github = createItem("login", "GitHub");
github.password = SECRET;

async function settle(rounds = 80): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("frames", () => {
  it("split a long code small enough for ntfy and join it back in any order", () => {
    const code = `osl-request.${"x".repeat(9000)}`;
    const frames = toFrames(code);
    expect(frames.length).toBe(4);
    for (const frame of frames) expect(frame.length).toBeLessThan(4096);
    const joiner = new Reassembler();
    const shuffled = [frames[2], frames[0], frames[0], frames[3], frames[1]];
    const out = shuffled.map((frame) => joiner.push(frame ?? ""));
    expect(out.filter((value) => value !== null)).toEqual([code]);
    // Heard once: the same frames again are not a second code.
    for (const frame of frames) expect(joiner.push(frame)).toBeNull();
  });

  it("ignore what is not a frame", () => {
    const joiner = new Reassembler();
    for (const junk of [
      "",
      "hello",
      "osl1.short.0.1.x",
      "osl1.AAAAAAAAAAA.1.1.x",
      "osl1.AAAAAAAAAAA.0.999.x",
    ])
      expect(joiner.push(junk)).toBeNull();
  });

  it("hold a bounded number of partial codes, for a bounded time", () => {
    let now = 0;
    const joiner = new Reassembler(() => now);
    for (let at = 0; at < 40; at += 1)
      joiner.push(toFrames("y".repeat(6000))[0] ?? "");
    const late = toFrames("z".repeat(6000));
    expect(joiner.push(late[0] ?? "")).toBeNull();
    expect(joiner.push(late[1] ?? "")).toBeNull();
    now = 10 * 60_000;
    const fresh = toFrames("w".repeat(3000));
    expect(joiner.push(fresh[0] ?? "")).toBeNull();
    expect(joiner.push(fresh[1] ?? "")).toBe("w".repeat(3000));
  });
});

const PROFILE: LiveTransport = {
  addresses: [],
  ice: [],
  relay: false,
  carriers: [{ kind: "nostr", url: "wss://relay.example.ts.net" }],
};

describe("a session paired over a carrier", () => {
  let net: FakeNet;
  let bus: FakeBus;
  const originalItems = liveSeams.items;

  beforeEach(() => {
    net = new FakeNet();
    bus = new FakeBus();
    liveSeams.items = () => [github];
  });
  afterEach(() => {
    endHosting();
    leaveLive();
    liveSeams.items = originalItems;
  });

  async function host(admission: "invite" | "open"): Promise<LiveHost> {
    return startHosting({
      title: "Team",
      scope: { kind: "vault" },
      policy: "read",
      admission,
      minutes: 30,
      peers: net.factory(),
      transport: PROFILE,
      carriers: bus.factory(),
    });
  }

  it("joins with no code pasted either way", async () => {
    const owner = await host("open");
    await settle();
    const guest = await joinLive({
      link: owner.link,
      code: null,
      name: "Ada",
      note: "",
      peers: net.factory(),
      useRoutes: true,
      carriers: bus.factory(),
    });
    await settle();
    expect(guest.status.at).toBe("joined");
    expect(owner.state.guests[0]).toMatchObject({
      name: "Ada",
      state: "joined",
    });
    expect(await guest.request("reveal", github.id, "password")).toBe(SECRET);
    // What crossed the service: framed, sealed, on the link's own topic.
    const topic = await carrierTopic(owner.link.secret);
    expect(bus.seen.every((entry) => entry.topic === topic)).toBe(true);
    const everything = bus.seen.map((entry) => entry.frame).join("\n");
    for (const plain of ["Ada", "v=0", "a=fake", owner.link.secret])
      expect(everything).not.toContain(plain);
  });

  it("an invite session still waits for the owner, then carries the reply", async () => {
    const owner = await host("invite");
    await settle();
    const guest = await joinLive({
      link: owner.link,
      code: owner.code,
      name: "Ada",
      note: "",
      peers: net.factory(),
      useRoutes: true,
      carriers: bus.factory(),
    });
    await settle();
    expect(owner.state.guests[0]?.state).toBe("asking");
    expect(guest.status.at).toBe("request");
    await owner.admit(owner.state.guests[0]?.key ?? "");
    await settle();
    expect(guest.status.at).toBe("joined");
  });

  it("junk on the topic is never a miss; a wrong code from a link holder is", async () => {
    const owner = await host("invite");
    await settle();
    const topic = await carrierTopic(owner.link.secret);
    for (const junk of [
      "hi",
      "osl-request.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ])
      for (const frame of toFrames(junk)) bus.inject(topic, frame);
    await settle();
    expect(owner.state.misses).toBe(0);
    const guess = await makeRequestCode(
      owner.link,
      "BCDF-GHJK",
      await newKeypair(),
      {
        id: newRequestId(),
        name: "Mallory",
        note: "",
        offer: "v=0\r\n",
      },
    );
    for (const frame of toFrames(guess)) bus.inject(topic, frame);
    await settle();
    expect(owner.state.misses).toBe(1);
  });

  it("the person declined the link's services: nothing is contacted", async () => {
    const owner = await host("open");
    await settle();
    const before = bus.seen.length;
    const guest = await joinLive({
      link: owner.link,
      code: null,
      name: "Ada",
      note: "",
      peers: net.factory(),
      useRoutes: false,
      carriers: bus.factory(),
    });
    await settle();
    expect(bus.seen.length).toBe(before);
    expect(guest.status.at).toBe("request");
    expect(currentGuest()).toBe(guest);
  });

  it("a carrier that cannot be reached leaves pasting by hand", async () => {
    bus.down = true;
    const owner = await host("open");
    await settle();
    expect(currentHostCarriers()?.states.map((state) => state.status)).toEqual([
      "failed",
    ]);
    const guest = await joinLive({
      link: owner.link,
      code: null,
      name: "Ada",
      note: "",
      peers: net.factory(),
      useRoutes: true,
      carriers: bus.factory(),
    });
    const request = guest.status.at === "request" ? guest.status.code : "";
    expect((await owner.receive(request)).kind).toBe("guest");
    expect(await guest.accept(owner.state.guests[0]?.reply ?? "")).toBe(true);
    await settle();
    expect(guest.status.at).toBe("joined");
  });
});
