/**
 * What a profile and a link may name (ADR 0150 §6): ICE URLs a browser will
 * take, a link that names nothing it should not, a segment a joiner can read,
 * and a profile that holds no repeats.
 */
import { describe, expect, it } from "vitest";
import { liveValue, readLiveValue } from "./link.js";
import {
  LiveRoutesRefused,
  MAX_ROUTES_SEGMENT,
  isIceUrl,
  readRoutes,
  routesSegment,
} from "./routes.js";
import {
  type LiveTransport,
  carriesCredentials,
  readTransport,
  routesRefusal,
  transportFileText,
} from "./transport.js";

/**
 * Each row was tried with `new RTCPeerConnection({ iceServers: [{ urls,
 * username, credential }] })` in Chromium (Playwright's, headless): `true`
 * built, `false` threw a SyntaxError. The unit is the table; the browser is
 * where it came from.
 */
const CHROMIUM: readonly (readonly [string, boolean])[] = [
  ["stun:a.b", true],
  ["stun:a.b:3478", true],
  ["stun:a.b:65535", true],
  ["stun:a.b:99999", false],
  ["stun:a.b:0", false],
  ["stun:a.b:65536", false],
  ["stun:a.b?transport=udp", false],
  ["stuns:a.b:5349?transport=tcp", false],
  ["stuns:a.b:5349", true],
  ["turn:a.b?transport=udp", true],
  ["turn:a.b:3478?transport=tcp", true],
  ["turns:a.b:443?transport=tcp", true],
  ["turn:a.b:0080", true],
  ["stun:[::1]:3478", true],
  ["turn:[fd7a::1]?transport=tcp", true],
  ["stun:1.2.3.4:1", true],
];

describe("ICE URLs", () => {
  it.each(CHROMIUM)("%s is %s to Chromium, and to us", (url, accepted) => {
    expect(isIceUrl(url)).toBe(accepted);
  });

  it.each([
    "",
    "stun:",
    "stun:a.b:",
    "https://a.b",
    "turn:a b",
    "stun:a.b?x=y",
  ])("refuses %j", (url) => expect(isIceUrl(url)).toBe(false));
});

describe("a link names only what it may", () => {
  const ICE = { urls: ["stun:stun.example.com:3478"] };

  it("refuses an unknown key inside a server or a carrier", () => {
    expect(readRoutes({ ice: [ICE] })).not.toBeNull();
    // A REST secret is the owner's; on a link it is a smuggled key.
    expect(readRoutes({ ice: [{ ...ICE, secret: "s" }] })).toBeNull();
    expect(readRoutes({ ice: [{ ...ICE, extra: 1 }] })).toBeNull();
    const carrier = { kind: "ntfy", url: "https://ntfy.example.com" };
    expect(readRoutes({ carriers: [carrier] })).not.toBeNull();
    expect(readRoutes({ carriers: [{ ...carrier, topic: "t" }] })).toBeNull();
  });

  it("refuses relay only with no TURN server, as the owner's profile does", () => {
    const turn = {
      urls: ["turn:turn.example.com:3478"],
      username: "u",
      credential: "c",
    };
    expect(readRoutes({ ice: [ICE], relay: true })).toBeNull();
    expect(readRoutes({ relay: true })).toBeNull();
    expect(readRoutes({ ice: [ICE, turn], relay: true })).not.toBeNull();
    expect(readRoutes({ ice: [ICE], relay: false })).not.toBeNull();
    expect(readTransport({ ice: [ICE], relay: true }).ok).toBe(false);
  });

  it("the owner's profile keeps `secret` and still refuses other strays", () => {
    const turn = { urls: ["turn:turn.example.com"], secret: "rest" };
    expect(readTransport({ ice: [turn] }).ok).toBe(true);
    const typo = readTransport({
      carriers: [{ kind: "mqtt", url: "wss://m.example.com", passwrod: "x" }],
    });
    expect(typo.ok).toBe(false);
    if (!typo.ok) expect(typo.errors.join(" ")).toContain('"passwrod"');
  });
});

describe("the routes segment", () => {
  const owner = "A".repeat(87);
  const secret = "A".repeat(43);
  const link = (routes: string) =>
    liveValue({ admission: "open", owner, secret, routes });

  it("is exactly as long as the joiner's parser reads (drift)", () => {
    expect(readLiveValue(link("x".repeat(MAX_ROUTES_SEGMENT)))).not.toBeNull();
    expect(readLiveValue(link("x".repeat(MAX_ROUTES_SEGMENT + 1)))).toBeNull();
  });

  const heavy = (count: number): LiveTransport => ({
    addresses: [],
    ice: [],
    relay: false,
    carriers: Array.from({ length: count }, (_, at) => ({
      kind: "nats" as const,
      url: `wss://n${at}.example.com`,
      username: "u".repeat(500),
      password: "p".repeat(500),
      token: "t".repeat(500),
    })),
  });

  it("refuses to make a link the joiner's parser would refuse", () => {
    const routes = { ice: [], relay: false, carriers: heavy(5).carriers };
    expect(() => routesSegment(routes)).toThrow(LiveRoutesRefused);
    expect(() => routesSegment(routes)).toThrow(/too long for a link/);
    expect(() => routesSegment({ ...routes, carriers: [] })).not.toThrow();
  });

  it("a profile whose link would be too long is refused where it is saved", () => {
    expect(routesRefusal(heavy(1))).toBeNull();
    expect(routesRefusal(heavy(5))).toMatch(/too long for a link/);
    const read = readTransport(JSON.parse(transportFileText(heavy(5))));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors[0]).toMatch(/too long for a link/);
    expect(readTransport(JSON.parse(transportFileText(heavy(1)))).ok).toBe(
      true,
    );
  });
});

describe("repeats in a profile", () => {
  it("are collapsed to their first, silently, and the next write is canonical", () => {
    const read = readTransport({
      addresses: ["100.64.0.1", "100.64.0.1", "FD7A::1", "fd7a::1"],
      ice: [
        { urls: ["stun:a.example.com"] },
        { urls: ["stun:a.example.com"] },
        { urls: ["stun:a.example.com"], username: "u", credential: "c" },
      ],
      carriers: [
        { kind: "ntfy", url: "https://ntfy.example.com" },
        { kind: "ntfy", url: "https://ntfy.example.com", token: "t" },
        { kind: "broadcast" },
        { kind: "broadcast" },
      ],
    });
    if (!read.ok) throw new Error(read.errors.join("; "));
    expect(read.transport.addresses).toEqual(["100.64.0.1", "FD7A::1"]);
    expect(read.transport.ice.map((server) => server.username)).toEqual([
      undefined,
      "u",
    ]);
    expect(read.transport.carriers.map((carrier) => carrier.kind)).toEqual([
      "ntfy",
      "broadcast",
    ]);
    expect(JSON.parse(transportFileText(read.transport)).addresses).toEqual([
      "100.64.0.1",
      "FD7A::1",
    ]);
  });
});

describe("credentials that travel in a link", () => {
  const base: LiveTransport = {
    addresses: [],
    ice: [],
    relay: false,
    carriers: [],
  };

  it("a static TURN login and any carrier credential do; a REST secret does not", () => {
    expect(carriesCredentials(base)).toBe(false);
    expect(
      carriesCredentials({
        ...base,
        ice: [{ urls: ["turn:t.example.com"], secret: "rest" }],
      }),
    ).toBe(false);
    expect(
      carriesCredentials({
        ...base,
        ice: [{ urls: ["turn:t.example.com"], username: "u", credential: "c" }],
      }),
    ).toBe(true);
    for (const field of ["username", "password", "token"] as const)
      expect(
        carriesCredentials({
          ...base,
          carriers: [
            { kind: "nats", url: "wss://n.example.com", [field]: "x" },
          ],
        }),
      ).toBe(true);
    expect(
      carriesCredentials({
        ...base,
        carriers: [{ kind: "nostr", url: "wss://r.example.com" }],
      }),
    ).toBe(false);
  });
});
