/**
 * A live session end to end, over a relay that carries the real signed and
 * encrypted events, between fake peers (ADR 0148).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveGuest } from "./guest.js";
import { type Admission, LiveHost, MAX_MISSES } from "./host.js";
import { formatLiveLink, parseLiveLink } from "./link.js";
import { FakeNet, MemoryRelay } from "./live-fakes.js";
import type { Catalog, SharePolicy } from "./messages.js";
import { DEFAULT_RELAYS } from "./relays.js";
import { endHosting, liveSeams, startHosting } from "./session.js";
import { Signaller, newSessionKey } from "./signal.js";

const RELAYS = ["wss://relay.example"];
const ICE = { iceServers: [], relayOnly: false };
const SECRET_VALUE = "correct horse battery staple";

function catalog(policy: "read" | "use" = "read"): Catalog {
  return {
    title: "Team vault",
    policy,
    expiresAt: Date.now() + 60_000,
    items: [
      {
        id: "item-1",
        name: "GitHub",
        type: "login",
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

type Room = { relay: MemoryRelay; net: FakeNet; host: LiveHost };

type RoomOptions = { admission?: Admission; policy?: SharePolicy };

function room(options: RoomOptions = {}): Room {
  const relay = new MemoryRelay();
  const net = new FakeNet();
  const host = new LiveHost({
    admission: options.admission ?? "invite",
    relays: RELAYS,
    ice: ICE,
    expiresAt: Date.now() + 60_000,
    catalog: () => catalog(options.policy),
    readField: async (item, field) =>
      item === "item-1" && field === "password" ? SECRET_VALUE : null,
    transport: relay.transport(),
    peers: net.factory(),
  });
  host.start();
  return { relay, net, host };
}

function guest(r: Room, code: string | null, name = "Ada"): LiveGuest {
  return new LiveGuest({
    link: r.host.link,
    code,
    name,
    note: "from design",
    relays: RELAYS,
    ice: ICE,
    transport: r.relay.transport(),
    peers: r.net.factory(),
  });
}

async function settle(): Promise<void> {
  for (let round = 0; round < 50; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const hosts: LiveHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.end();
  vi.useRealTimers();
});

describe("an invite session", () => {
  it("holds a proved ask for the owner, and makes no peer before admission", async () => {
    const r = room();
    hosts.push(r.host);
    const g = guest(r, r.host.code);
    await g.ask();
    await settle();
    expect(g.status.at).toBe("waiting");
    expect(r.host.state.guests.map((x) => [x.name, x.state])).toEqual([
      ["Ada", "asking"],
    ]);
    // Nobody has gathered an address yet.
    expect(r.net.created).toBe(0);

    await r.host.admit(r.host.state.guests[0]?.key ?? "");
    await settle();
    expect(r.net.created).toBe(2);
    expect(g.status.at).toBe("joined");
    expect(r.host.state.guests[0]?.state).toBe("joined");
  });

  it("shows only what is not concealed until asked, and answers one field at a time", async () => {
    const r = room();
    hosts.push(r.host);
    const g = guest(r, r.host.code);
    await g.ask();
    await settle();
    await r.host.admit(r.host.state.guests[0]?.key ?? "");
    await settle();
    const status = g.status;
    if (status.at !== "joined") throw new Error(status.at);
    const fields = status.catalog.items[0]?.fields ?? [];
    expect(fields.map((field) => field.value)).toEqual(["octo", null]);
    // Nothing concealed crossed with the catalog.
    expect(JSON.stringify(status.catalog)).not.toContain(SECRET_VALUE);

    expect(await g.request("reveal", "item-1", "password")).toBe(SECRET_VALUE);
    expect(await g.request("reveal", "item-1", "username")).toBeNull();
    expect(await g.request("reveal", "item-2", "password")).toBeNull();
    expect(r.host.state.log.map((entry) => entry.what)).toEqual([
      "reveal",
      "denied",
      "denied",
    ]);
  });

  it("under `use`, copies but never reveals", async () => {
    const r = room({ policy: "use" });
    hosts.push(r.host);
    const g = guest(r, r.host.code);
    await g.ask();
    await settle();
    await r.host.admit(r.host.state.guests[0]?.key ?? "");
    await settle();
    expect(await g.request("reveal", "item-1", "password")).toBeNull();
    expect(await g.request("copy", "item-1", "password")).toBe(SECRET_VALUE);
  });

  it("refuses a wrong code, and the fifth miss ends the session", async () => {
    const r = room();
    hosts.push(r.host);
    for (let miss = 1; miss <= MAX_MISSES; miss += 1) {
      const g = guest(r, "BCDF-GHJK", `guess ${miss}`);
      await g.ask();
      await settle();
      expect(g.status).toEqual({ at: "refused", reason: "code" });
    }
    expect(r.host.state.status).toBe("ended");
    expect(r.host.state.endedBecause).toBe("code");
    expect(r.net.created).toBe(0);
  });

  it("drops asks that cannot prove the link: an onlooker cannot burn the session", async () => {
    // Once the owner has answered anyone its key is public on the relays.
    const r = room();
    hosts.push(r.host);
    const onlooker = new Signaller(
      newSessionKey(),
      RELAYS,
      r.relay.transport(),
    );
    const heard: string[] = [];
    onlooker.listen((incoming) => heard.push(incoming.signal.t));
    const junk = "0".repeat(64);
    for (let tries = 0; tries < MAX_MISSES + 2; tries += 1)
      await onlooker.send(r.host.link.owner, {
        t: "ask",
        name: "x",
        note: "",
        held: junk,
        proof: junk,
      });
    await settle();
    expect(r.host.state.misses).toBe(0);
    expect(r.host.state.status).toBe("live");
    expect(r.host.state.guests).toEqual([]);
    expect(heard).toEqual([]);
    // A real joiner still gets in.
    const g = guest(r, r.host.code);
    await g.ask();
    await settle();
    expect(g.status).toEqual({ at: "waiting" });
    onlooker.close();
  });

  it("the link alone is not the code", async () => {
    const r = room();
    hosts.push(r.host);
    const g = guest(r, null);
    await g.ask();
    await settle();
    expect(g.status).toEqual({ at: "refused", reason: "code" });
  });

  it("a refused asker never learns an address", async () => {
    const r = room();
    hosts.push(r.host);
    const g = guest(r, r.host.code);
    await g.ask();
    await settle();
    await r.host.refuse(r.host.state.guests[0]?.key ?? "");
    await settle();
    expect(g.status).toEqual({ at: "refused", reason: "declined" });
    expect(r.net.created).toBe(0);
  });

  it("ending drops everything the guest held", async () => {
    const r = room();
    hosts.push(r.host);
    const g = guest(r, r.host.code);
    await g.ask();
    await settle();
    await r.host.admit(r.host.state.guests[0]?.key ?? "");
    await settle();
    r.host.end();
    await settle();
    expect(g.status).toEqual({ at: "ended" });
    expect(await g.request("reveal", "item-1", "password")).toBeNull();
  });
});

describe("an open session", () => {
  it("admits whoever holds the link, without a code", async () => {
    const r = room({ admission: "open" });
    hosts.push(r.host);
    expect(r.host.code).toBeNull();
    const g = guest(r, null);
    await g.ask();
    await settle();
    expect(g.status.at).toBe("joined");
  });
});

describe("the relays", () => {
  it("see only session keys and ciphertext", async () => {
    const r = room();
    hosts.push(r.host);
    const g = guest(r, r.host.code);
    await g.ask();
    await settle();
    await r.host.admit(r.host.state.guests[0]?.key ?? "");
    await settle();
    await g.request("reveal", "item-1", "password");
    const wire = JSON.stringify(r.relay.seen);
    for (const leaked of [
      "Ada",
      "from design",
      "GitHub",
      "octo",
      SECRET_VALUE,
      r.host.code ?? "",
      r.host.link.secret,
    ])
      expect(wire).not.toContain(leaked);
    expect(r.relay.seen.every((event) => event.kind === 25548)).toBe(true);
  });

  it("a message not signed by the link's owner key is not the owner's", async () => {
    const r = room();
    hosts.push(r.host);
    const g = guest(r, r.host.code);
    await g.ask();
    await settle();
    // Somebody else on the relays — even one who read the link — answers the
    // asker directly. The guest only hears the owner the link named.
    const asker =
      r.relay.seen.find((event) => event.pubkey !== r.host.link.owner)
        ?.pubkey ?? "";
    const impostor = new Signaller(
      newSessionKey(),
      RELAYS,
      r.relay.transport(),
    );
    await impostor.send(asker, { t: "refuse", reason: "declined" });
    await settle();
    expect(g.status.at).toBe("waiting");
  });
});

describe("links", () => {
  it("round-trip through the app's address, relays included", () => {
    const r = room();
    hosts.push(r.host);
    const url = formatLiveLink(
      "https://example.org/OpenSesame/?x=1#old",
      r.host.link,
    );
    expect(url.startsWith("https://example.org/OpenSesame/#live=v1.i.")).toBe(
      true,
    );
    expect(parseLiveLink(url)).toEqual(r.host.link);
  });

  it("refuse anything that is not exactly a link", () => {
    for (const raw of [
      "",
      "hello",
      "https://example.org/#live=v2.i.aa.bb",
      `https://example.org/#live=v1.i.${"g".repeat(64)}.${"a".repeat(43)}`,
      `https://example.org/#live=v1.i.${"a".repeat(64)}.${"a".repeat(42)}`,
      `https://example.org/#live=v1.x.${"a".repeat(64)}.${"a".repeat(43)}`,
      `https://example.org/#live=v1.${"a".repeat(64)}.${"a".repeat(43)}`,
      "javascript:alert(1)#live=v1.x.y",
    ])
      expect(parseLiveLink(raw)).toBeNull();
  });
});

describe("the relays a hosted session meets on", () => {
  const original = { ...liveSeams };
  afterEach(() => {
    endHosting();
    Object.assign(liveSeams, original);
  });

  function host(relays?: readonly string[]) {
    Object.assign(liveSeams, {
      transport: () => new MemoryRelay().transport(),
      items: () => [],
      onLock: () => () => {},
    });
    return startHosting({
      title: "t",
      scope: { kind: "vault" },
      policy: "use",
      admission: "invite",
      minutes: 5,
      peers: new FakeNet().factory(),
      relays,
    }).link.relays;
  }

  it("uses the relays Settings names, else the defaults", () => {
    liveSeams.relays = () => ["wss://mine.example"];
    expect(host()).toEqual(["wss://mine.example"]);
    liveSeams.relays = () => [];
    expect(host()).toEqual(DEFAULT_RELAYS);
    expect(host(["wss://asked.example"])).toEqual(["wss://asked.example"]);
  });
});
