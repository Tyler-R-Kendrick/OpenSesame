/**
 * The optional transport profile, the routes a link carries, and the
 * address hints a tunnel needs (ADR 0150 §6).
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SAME_MACHINE_LOOPBACK_HINTS,
  withAddressHints,
} from "./candidates.js";
import { formatLiveLink, parseLiveLink } from "./link.js";
import { linkRoutes, routesSegment } from "./routes.js";
import { newKeypair, newLinkSecret } from "./seal.js";
import {
  NO_ROUTES,
  isAddress,
  isCarrierUrl,
  readTransport,
  routeHosts,
  routesFor,
  transportFileText,
  turnRestCredential,
} from "./transport.js";

const PROFILE = {
  addresses: ["100.101.102.103", "fd7a:115c:a1e0::1"],
  ice: [
    { urls: ["stun:turn.example.ts.net:3478"] },
    {
      urls: [
        "turn:turn.example.ts.net:3478",
        "turns:turn.example.com:443?transport=tcp",
      ],
      secret: "rest-shared-secret",
    },
  ],
  relay: false,
  carriers: [
    { kind: "nostr", url: "wss://relay.example.ts.net" },
    {
      kind: "mqtt",
      url: "wss://mqtt.example.com/mqtt",
      username: "live",
      password: "pw",
    },
    { kind: "nats", url: "wss://nats.example.com", token: "t0k" },
    { kind: "ntfy", url: "https://ntfy.example.com" },
    { kind: "broadcast" },
  ],
};

describe("the transport profile", () => {
  it("reads a full profile and writes it back the same", () => {
    const read = readTransport(PROFILE);
    if (!read.ok) throw new Error(read.errors.join("; "));
    expect(read.transport.addresses).toEqual(PROFILE.addresses);
    expect(read.transport.carriers.map((c) => c.kind)).toEqual([
      "nostr",
      "mqtt",
      "nats",
      "ntfy",
      "broadcast",
    ]);
    const again = readTransport(JSON.parse(transportFileText(read.transport)));
    expect(again).toEqual(read);
  });

  it("an empty profile is direct only", () => {
    expect(readTransport({})).toEqual({
      ok: true,
      transport: { addresses: [], ice: [], relay: false, carriers: [] },
    });
    expect(
      transportFileText({ addresses: [], ice: [], relay: false, carriers: [] }),
    ).toBe("{}\n");
  });

  it.each([
    [{ addresses: ["tailnet-host"] }, "not an IP address"],
    [{ addresses: ["224.0.0.1"] }, "not an IP address"],
    [{ addresses: ["0.0.0.0"] }, "not an IP address"],
    [{ ice: [{ urls: ["https://turn.example.com"] }] }, "stun: or turn:"],
    [{ ice: [{ urls: ["turn:turn.example.com"] }] }, "username and credential"],
    [{ relay: true }, "relay needs at least one TURN"],
    [{ carriers: [{ kind: "nostr", url: "ws://100.64.0.1:7777" }] }, "wss://"],
    [
      { carriers: [{ kind: "ntfy", url: "http://ntfy.example.com" }] },
      "https://",
    ],
    [
      { carriers: [{ kind: "mqtt", url: "wss://u:p@mqtt.example.com" }] },
      "wss://",
    ],
    [
      { carriers: [{ kind: "smoke-signal", url: "wss://x.example" }] },
      "kind must be",
    ],
    [{ tunnels: [] }, 'Unknown key "tunnels"'],
  ])("refuses %j", (profile, message) => {
    const read = readTransport(profile);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors.join(" ")).toContain(message);
  });

  it("knows an address from a name", () => {
    expect(isAddress("100.64.0.7")).toBe(true);
    expect(isAddress("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240")).toBe(true);
    expect(isAddress("ff02::1")).toBe(false);
    expect(isAddress("owner.tailnet.ts.net")).toBe(false);
    expect(isCarrierUrl("nostr", "ws://127.0.0.1:7777")).toBe(true);
    expect(isCarrierUrl("ntfy", "http://localhost:8080")).toBe(true);
  });
});

describe("TURN REST credentials", () => {
  it("are coturn's use-auth-secret: HMAC-SHA1 over <expiry>:osl", async () => {
    const expiresAt = 1_900_000_000_000;
    const minted = await turnRestCredential("rest-shared-secret", expiresAt);
    expect(minted.username).toBe("1900000000:osl");
    expect(minted.credential).toBe(
      createHmac("sha1", "rest-shared-secret")
        .update("1900000000:osl")
        .digest("base64"),
    );
  });

  it("a link carries the minted credential, never the secret", async () => {
    const read = readTransport(PROFILE);
    if (!read.ok) throw new Error("profile");
    const routes = await routesFor(read.transport, Date.now() + 60_000);
    expect(JSON.stringify(routes)).not.toContain("rest-shared-secret");
    expect(routes.ice[1]).toMatchObject({
      username: expect.stringMatching(/:osl$/),
    });
    expect(routeHosts(routes)).toEqual([
      "turn.example.ts.net",
      "turn.example.com",
      "relay.example.ts.net",
      "mqtt.example.com",
      "nats.example.com",
      "ntfy.example.com",
      "this browser",
    ]);
  });
});

describe("a link with routes", () => {
  it("round-trips them, and the join screen refuses routes that are not strict", async () => {
    const read = readTransport(PROFILE);
    if (!read.ok) throw new Error("profile");
    const routes = await routesFor(read.transport, Date.now() + 60_000);
    const link = {
      admission: "open" as const,
      owner: (await newKeypair()).pub,
      secret: newLinkSecret(),
      routes: routesSegment(routes),
    };
    const url = formatLiveLink("https://example.test/OpenSesame/", link);
    const parsed = parseLiveLink(url);
    expect(parsed).toEqual(link);
    expect(parsed && linkRoutes(parsed)).toEqual(routes);
    const direct = formatLiveLink("https://example.test/", {
      ...link,
      routes: routesSegment(NO_ROUTES),
    });
    expect(direct).toMatch(/#live=v1\.o\.[\w-]{87}\.[\w-]{43}$/);
    const none = parseLiveLink(direct);
    expect(none && linkRoutes(none)).toEqual(NO_ROUTES);
    const empty = parseLiveLink(`${direct}.e30`);
    expect(empty && linkRoutes(empty)).toEqual(NO_ROUTES);
    // The door knows the link by its shape; routes naming a plain socket
    // elsewhere do not read, and the join screen refuses the link whole.
    const bad = btoa(
      JSON.stringify({
        carriers: [{ kind: "nats", url: "ws://nats.example.com" }],
      }),
    ).replace(/=+$/, "");
    const refused = parseLiveLink(`${direct}.${bad}`);
    expect(refused && linkRoutes(refused)).toBeNull();
    expect(parseLiveLink(`${direct}.not*base64`)).toBeNull();
  });
});

describe("address hints", () => {
  const OFFER = [
    "v=0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "a=candidate:1467250027 1 udp 2122260223 4f2e9f5a-0c1d.local 54400 typ host generation 0",
    "a=candidate:1467250028 1 tcp 1518280447 4f2e9f5a-0c1d.local 9 typ host tcptype active",
    "a=candidate:842163049 1 udp 1686052607 203.0.113.9 54400 typ srflx raddr 0.0.0.0 rport 0",
    "a=end-of-candidates",
    "",
  ].join("\r\n");

  it("adds each host candidate again at each address, same port", () => {
    const hinted = withAddressHints(OFFER, ["100.101.102.103"]);
    const lines = hinted.split("\r\n");
    expect(lines).toContain(
      "a=candidate:1467250027h0 1 udp 2122260222 100.101.102.103 54400 typ host generation 0",
    );
    expect(lines).toContain(
      "a=candidate:1467250028h0 1 tcp 1518280446 100.101.102.103 9 typ host tcptype active",
    );
    // The originals stay, and a reflexive candidate gets no copy.
    expect(
      lines.filter((line) => line.startsWith("a=candidate:")),
    ).toHaveLength(5);
    expect(hinted.endsWith("\r\n")).toBe(true);
  });

  it("changes nothing with no address", () => {
    expect(withAddressHints(OFFER, [])).toBe(OFFER);
  });

  it("adds loopback copies for same-machine direct pairing", () => {
    const hinted = withAddressHints(OFFER, SAME_MACHINE_LOOPBACK_HINTS);
    expect(hinted).toContain("127.0.0.1 54400 typ host");
    expect(hinted).toContain("::1 9 typ host tcptype active");
  });
});
