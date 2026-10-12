/**
 * A live session end to end: sealed pairing codes passed by hand, between
 * fake peers (ADR 0150). No server of any kind is involved.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LiveGuest } from "./guest.js";
import { type Admission, LiveHost, MAX_GUESTS, MAX_MISSES } from "./host.js";
import { formatLiveLink, parseLiveLink } from "./link.js";
import { FakeNet, fakeSdp } from "./live-fakes.js";
import type { Catalog, SharePolicy } from "./messages.js";
import {
  makeReplyCode,
  makeRequestCode,
  openReplyCode,
  openRequestCode,
} from "./pairing.js";
import { isDataChannelSdp as sdp } from "./sdp.js";
import { newKeypair, newLinkSecret, newRequestId } from "./seal.js";

const SECRET_VALUE = "correct horse battery staple";

function catalog(policy: SharePolicy = "read"): Catalog {
  return {
    title: "Team vault",
    policy,
    expiresAt: Date.now() + 60_000,
    items: [
      {
        id: "item-1",
        name: "GitHub",
        type: "account",
        fields: [
          {
            key: "username",
            label: "Username",
            concealed: false,
            value: "octo",
          },
          { key: "password", label: "Password", concealed: true, value: null },
        ],
      },
    ],
  };
}

type Room = { net: FakeNet; host: LiveHost };
type RoomOptions = { admission?: Admission; policy?: SharePolicy };

const hosts: LiveHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.end();
});

async function room(options: RoomOptions = {}): Promise<Room> {
  const net = new FakeNet();
  const host = await LiveHost.start({
    admission: options.admission ?? "invite",
    expiresAt: Date.now() + 60_000,
    catalog: () => catalog(options.policy),
    readField: async (item, field) =>
      item === "item-1" && field === "password" ? SECRET_VALUE : null,
    transport: net.transport(),
  });
  hosts.push(host);
  return { net, host };
}

function guest(r: Room, code: string | null, name = "Ada"): LiveGuest {
  return new LiveGuest({
    link: r.host.link,
    code,
    name,
    note: "from design",
    transport: r.net.transport(),
  });
}

async function settle(): Promise<void> {
  for (let round = 0; round < 50; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The whole handshake: request code over, reply code back. */
async function pair(r: Room, g: LiveGuest): Promise<void> {
  const request = await g.start();
  const received = await r.host.receive(request);
  if (received.kind !== "guest") throw new Error(received.kind);
  await r.host.admit(received.key);
  const reply = r.host.state.guests.find((x) => x.key === received.key)?.reply;
  expect(await g.accept(reply ?? "")).toBe(true);
  await settle();
}

describe("the link", () => {
  it("round-trips through the app's own address, and names no server", async () => {
    const r = await room();
    const url = formatLiveLink("https://example.test/OpenSesame/", r.host.link);
    expect(url).toMatch(/^https:\/\/example\.test\/OpenSesame\/#live=v1\.i\./);
    expect(parseLiveLink(url)).toEqual(r.host.link);
    expect(url).not.toMatch(/wss?:|stun:|turn:/);
    expect(parseLiveLink("https://example.test/#live=v2.i.x.y")).toBeNull();
  });
});

describe("an invite session", () => {
  it("answers an offer only once the owner lets the person in, then hands over one value on request", async () => {
    const r = await room();
    const g = guest(r, r.host.code);
    const request = await g.start();
    expect(g.status).toEqual({ at: "request", code: request });
    const created = r.net.created;
    const received = await r.host.receive(request);
    expect(received).toEqual({ kind: "guest", key: expect.any(String) });
    const [asking] = r.host.state.guests;
    expect(asking).toMatchObject({ name: "Ada", note: "from design" });
    expect(asking?.state).toBe("asking");
    expect(asking?.reply).toBeNull();
    // Not let in: the owner has made no peer and written no address.
    expect(r.net.created).toBe(created);

    await r.host.admit(asking?.key ?? "");
    const reply = r.host.state.guests[0]?.reply ?? "";
    expect(reply).toMatch(/^osl-reply\./);
    expect(await g.accept(reply)).toBe(true);
    await settle();
    expect(g.status.at).toBe("joined");
    expect(r.host.state.guests[0]?.state).toBe("joined");
    expect(JSON.stringify(g.status)).not.toContain(SECRET_VALUE);
    expect(await g.request("reveal", "item-1", "password")).toBe(SECRET_VALUE);
    expect(await g.request("reveal", "item-1", "username")).toBeNull();
    expect(await g.request("copy", "item-9", "password")).toBeNull();
    expect(r.host.state.log.map((entry) => entry.what)).toEqual([
      "reveal",
      "denied",
      "denied",
    ]);
  });

  it("seals the codes: no name, note, offer or answer in the clear", async () => {
    const r = await room();
    const g = guest(r, r.host.code);
    const request = await g.start();
    for (const plain of ["Ada", "from design", "v=0", "a=fake"])
      expect(request).not.toContain(plain);
    const received = await r.host.receive(request);
    if (received.kind === "guest") await r.host.admit(received.key);
    const reply = r.host.state.guests[0]?.reply ?? "";
    expect(reply).not.toContain("v=0");
    expect(reply).not.toContain("a=fake");
  });

  it("the link alone is not the code, and the fifth miss locks the session", async () => {
    const r = await room();
    for (let miss = 1; miss <= MAX_MISSES; miss += 1) {
      const code = miss === 1 ? null : "BCDF-GHJK";
      const request = await guest(r, code, `guess ${miss}`).start();
      expect(await r.host.receive(request)).toEqual({
        kind: "not-this-session",
        misses: miss,
      });
    }
    // Locked, not ended: nothing new is taken, and nobody in is thrown out.
    expect(r.host.state).toMatchObject({
      status: "live",
      endedBecause: null,
      locked: true,
    });
    const right = await guest(r, r.host.code, "Right code, too late").start();
    expect(await r.host.receive(right)).toEqual({ kind: "locked" });
    expect(r.host.state.guests).toEqual([]);
  });

  it("counts a wrong code once however often its joiner reposts it", async () => {
    const r = await room();
    const request = await guest(r, "BCDF-GHJK").start();
    for (let repost = 0; repost < MAX_MISSES * 3; repost += 1)
      expect(await r.host.receive(request)).toEqual({
        kind: "not-this-session",
        misses: 1,
      });
    expect(r.host.state.status).toBe("live");
    // A different wrong code is a new guess.
    const other = await guest(r, "BCDF-GHJL").start();
    expect(await r.host.receive(other)).toEqual({
      kind: "not-this-session",
      misses: 2,
    });
  });

  it("does not count text that is not a request code at all", async () => {
    const r = await room();
    for (const text of ["", "hello", "osl-reply.abc", "osl-request.!!!"])
      expect(await r.host.receive(text)).toEqual({ kind: "not-a-request" });
    expect(r.host.state.misses).toBe(0);
  });

  it("forgives what a chat app wraps around a pasted code", async () => {
    const r = await room();
    const request = await guest(r, r.host.code).start();
    const wrapped = `"${request.slice(0, 40)}\n  ${request.slice(40)}"`;
    expect((await r.host.receive(wrapped)).kind).toBe("guest");
  });

  it("seats a request once, however often it is pasted", async () => {
    const r = await room();
    const request = await guest(r, r.host.code).start();
    await r.host.receive(request);
    await r.host.receive(request);
    expect(r.host.state.guests).toHaveLength(1);
  });

  it("is full at eight people", async () => {
    const r = await room();
    for (let seat = 0; seat < MAX_GUESTS; seat += 1)
      await r.host.receive(await guest(r, r.host.code, `p${seat}`).start());
    const late = await guest(r, r.host.code, "late").start();
    expect(await r.host.receive(late)).toEqual({ kind: "full" });
  });

  it("takes a reply only for this request, from this owner", async () => {
    const r = await room();
    const a = guest(r, r.host.code, "A");
    const b = guest(r, r.host.code, "B");
    await b.start();
    const received = await r.host.receive(await a.start());
    if (received.kind === "guest") await r.host.admit(received.key);
    const reply = r.host.state.guests[0]?.reply ?? "";
    // Somebody else's reply does not connect B.
    expect(await b.accept(reply)).toBe(false);
    expect(b.status.at).toBe("request");
    expect(await a.accept(reply)).toBe(true);
  });

  it("a person turned away gets no reply", async () => {
    const r = await room();
    const received = await r.host.receive(await guest(r, r.host.code).start());
    const key = received.kind === "guest" ? received.key : "";
    r.host.refuse(key);
    await r.host.admit(key);
    expect(r.host.state.guests[0]).toMatchObject({
      state: "refused",
      reply: null,
    });
  });
});

describe("the codes' keys", () => {
  const id = newRequestId();
  const request = { id, name: "Ada", note: "", offer: fakeSdp(), greets: true };

  async function session() {
    const owner = await newKeypair();
    const link = {
      admission: "invite" as const,
      owner: owner.pub,
      secret: newLinkSecret(),
      routes: null,
    };
    return { owner, link, code: "BCDF-GHJK" };
  }

  it("only the owner opens a request; another link holder cannot", async () => {
    const { owner, link, code } = await session();
    const joiner = await newKeypair();
    const sealed = await makeRequestCode(link, code, joiner, request);
    const opened = await openRequestCode(link, code, owner, sealed, sdp);
    expect(opened).toMatchObject({ kind: "request", joiner: joiner.pub });
    // A co-joiner holds the link and the code, but not the owner's key.
    const onlooker = await newKeypair();
    expect(
      (await openRequestCode(link, code, onlooker, sealed, sdp)).kind,
    ).toBe("not-this-session");
  });

  it("a request sealed for another link is noise, never a miss", async () => {
    const { owner, link, code } = await session();
    const other = { ...link, secret: newLinkSecret() };
    const sealed = await makeRequestCode(
      other,
      code,
      await newKeypair(),
      request,
    );
    expect(await openRequestCode(link, code, owner, sealed, sdp)).toEqual({
      kind: "not-a-request",
    });
  });

  it("a reply from anyone but the owner does not open", async () => {
    const { owner, link, code } = await session();
    const joiner = await newKeypair();
    const reply = { id, answer: fakeSdp() };
    const real = await makeReplyCode(link, code, owner, joiner.pub, reply);
    expect(await openReplyCode(link, code, joiner, id, real, sdp)).toEqual(
      reply,
    );
    const impostor = await newKeypair();
    const forged = await makeReplyCode(link, code, impostor, joiner.pub, reply);
    expect(await openReplyCode(link, code, joiner, id, forged, sdp)).toBeNull();
    // Nor does the owner's reply to one joiner open for another.
    expect(
      await openReplyCode(link, code, await newKeypair(), id, real, sdp),
    ).toBeNull();
    expect(
      await openReplyCode(link, code, joiner, newRequestId(), real, sdp),
    ).toBeNull();
  });
});

describe("policies and endings", () => {
  it("under `use`, neither reveals nor hands the secret over to copy", async () => {
    const r = await room({ policy: "use" });
    const g = guest(r, r.host.code);
    await pair(r, g);
    expect(await g.request("reveal", "item-1", "password")).toBeNull();
    expect(await g.request("copy", "item-1", "password")).toBeNull();
    expect(JSON.stringify(g.status)).not.toContain(SECRET_VALUE);
    expect(r.host.state.log.map((entry) => entry.what)).toEqual([
      "denied",
      "denied",
    ]);
  });

  it("an open session asks for no code and answers at once", async () => {
    const r = await room({ admission: "open" });
    expect(r.host.code).toBeNull();
    const g = guest(r, null);
    const received = await r.host.receive(await g.start());
    expect(received.kind).toBe("guest");
    const reply = r.host.state.guests[0]?.reply ?? "";
    expect(await g.accept(reply)).toBe(true);
    await settle();
    expect(g.status.at).toBe("joined");
  });

  it("ending the session drops everything the joiner held", async () => {
    const r = await room();
    const g = guest(r, r.host.code);
    await pair(r, g);
    r.host.end();
    await settle();
    expect(g.status).toEqual({ at: "ended" });
    expect(await g.request("reveal", "item-1", "password")).toBeNull();
    expect(r.host.state.guests[0]?.state).toBe("gone");
  });

  it("says so when the two browsers find no direct route", async () => {
    const r = await room();
    r.net.unreachable = true;
    const g = guest(r, r.host.code);
    await pair(r, g);
    expect(g.status).toEqual({ at: "unreachable" });
  });

  it("the owner sees a joiner leave", async () => {
    const r = await room();
    const g = guest(r, r.host.code);
    await pair(r, g);
    g.leave();
    await settle();
    expect(r.host.state.guests[0]?.state).toBe("gone");
  });
});
