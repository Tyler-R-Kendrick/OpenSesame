import { afterEach, beforeEach, describe, expect, it } from "vitest";
/**
 * Carriers passing the pairing codes (ADR 0150 §6): the frames, and a whole
 * session paired with nobody pasting anything — over a fake carrier service
 * that anyone may post junk to.
 */
import { plainAccount } from "../account.test-support.js";
import type { LiveHost } from "./host.js";
import { FakeBus, FakeNet, fakeSdp } from "./live-fakes.js";
import { makeRequestCode, openRequestCode } from "./pairing.js";
import { Reassembler, carrierTopic, toFrames } from "./rendezvous.js";
import { isDataChannelSdp } from "./sdp.js";
import { newKeypair, newLinkSecret, newRequestId } from "./seal.js";
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
const github = plainAccount("GitHub", SECRET);

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

  it("hold partial codes for a bounded time", () => {
    let now = 0;
    const joiner = new Reassembler(() => now);
    const stale = toFrames("y".repeat(6000));
    joiner.push(stale[0] ?? "");
    now = 10 * 60_000;
    // Its first frame has aged out: the rest never completes it.
    expect(joiner.push(stale[1] ?? "")).toBeNull();
    expect(joiner.push(stale[2] ?? "")).toBeNull();
    const fresh = toFrames("w".repeat(3000));
    expect(joiner.push(fresh[0] ?? "")).toBeNull();
    expect(joiner.push(fresh[1] ?? "")).toBe("w".repeat(3000));
  });

  it("make room for a new code by dropping the oldest, so nobody can lock the topic up", () => {
    const joiner = new Reassembler();
    // Whoever holds the topic starts many long messages and finishes none.
    const started = Array.from({ length: 40 }, () =>
      toFrames("y".repeat(6000)),
    );
    for (const frames of started) joiner.push(frames[0] ?? "");
    // A real one, arriving now, still gets through whole.
    const real = toFrames("z".repeat(6000));
    const heard = real.map((frame) => joiner.push(frame));
    expect(heard).toEqual([null, null, "z".repeat(6000)]);
    // The flood's oldest starts were the ones dropped; a late tail of the
    // first cannot finish it.
    const oldest = started[0] ?? [];
    expect(joiner.push(oldest[1] ?? "")).toBeNull();
    expect(joiner.push(oldest[2] ?? "")).toBeNull();
  });

  it("a chunk slipped into a message spoils that message, and the repost still arrives", async () => {
    const owner = await newKeypair();
    const link = {
      admission: "open" as const,
      owner: owner.pub,
      secret: newLinkSecret(),
      routes: null,
    };
    // Long enough to need several frames.
    const padding = Array.from(
      { length: 10 },
      () => `${"a=x-pad:".padEnd(400, "a")}\r\n`,
    ).join("");
    const code = await makeRequestCode(link, null, await newKeypair(), {
      id: newRequestId(),
      name: "Ada",
      note: "",
      offer: `${fakeSdp()}${padding}`,
      greets: true,
    });
    const joiner = new Reassembler();
    const frames = toFrames(code);
    expect(frames.length).toBeGreaterThan(1);
    const [prefix, id, , count] = (frames[0] ?? "").split(".");
    const bogus = `${prefix}.${id}.1.${count}.${"x".repeat(100)}`;
    const heard = [frames[0], bogus, ...frames.slice(1)].map((frame) =>
      joiner.push(frame ?? ""),
    );
    const spoiled = heard.find((value) => value !== null);
    expect(spoiled).toBeDefined();
    expect(spoiled).not.toBe(code);
    // What it made is no request — and no miss.
    expect(
      (
        await openRequestCode(
          link,
          null,
          owner,
          spoiled ?? "",
          isDataChannelSdp,
        )
      ).kind,
    ).toBe("not-a-request");
    // The joiner's next post has an id of its own.
    const again = toFrames(code).map((frame) => joiner.push(frame));
    expect(again.filter((value) => value !== null)).toEqual([code]);
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
      transport: net.transports(),
      routes: PROFILE,
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
      transport: net.transports(),
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
      transport: net.transports(),
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
        greets: true,
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
      transport: net.transports(),
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
      transport: net.transports(),
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
