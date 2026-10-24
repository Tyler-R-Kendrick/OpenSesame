/**
 * The addresses a session's person authorized (ADR 0150 §6, amended
 * 2026-10-24): a received description keeps a candidate at a non-public
 * literal only when the address is exactly one this side named itself or
 * allowed, or, for a relay candidate, the literal host of a TURN server it
 * named. Nothing is admitted by default, loopback included. The owner's
 * reply names its Routes addresses for the joiner to allow.
 */
import { describe, expect, it } from "vitest";
import { readJoinReply } from "./messages.js";
import {
  NAMED_ADDRESSES_MAX,
  canonicalAddress,
  sessionNamedAddresses,
  turnServerHosts,
  withNamedAddresses,
} from "./named-addresses.js";
import { filterDataChannelSdp, isDataChannelSdp } from "./sdp.js";

const ID = "abcdefghijklmnopqrstuv";
const HEAD = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0"];
const MEDIA = "m=application 9 UDP/DTLS/SCTP webrtc-datachannel";

/** A description whose candidates are of one type, one per address. */
function typed(type: "host" | "relay", addresses: readonly string[]): string {
  const lines = [...HEAD, MEDIA, "c=IN IP4 0.0.0.0", "a=mid:0"];
  const tail = type === "relay" ? " raddr 0.0.0.0 rport 0" : "";
  addresses.forEach((address, at) => {
    lines.push(
      `a=candidate:${at + 1} 1 udp 2113937151 ${address} 54400 typ ${type}${tail}`,
    );
  });
  return `${lines.join("\r\n")}\r\n`;
}

function described(...addresses: string[]): string {
  return typed("host", addresses);
}

function relayed(...addresses: string[]): string {
  return typed("relay", addresses);
}

/** The addresses whose candidates survive the filter, in order. */
function kept(
  sdp: string,
  named: readonly string[],
  turn: readonly string[] = [],
): string[] {
  const filtered = filterDataChannelSdp(
    sdp,
    sessionNamedAddresses(named, [{ urls: turn }]),
  );
  if (filtered === null) throw new Error("description refused");
  return filtered
    .split("\r\n")
    .filter((line) => line.startsWith("a=candidate:"))
    .map((line) => line.split(" ")[4] ?? "");
}

/** What a test reply carries beside its id and answer. */
type ReplyFields = { addresses?: string | string[] };

function reply(fields: ReplyFields) {
  return readJoinReply(
    JSON.stringify({ id: ID, answer: described(), ...fields }),
    isDataChannelSdp,
  );
}

describe("a received description keeps only what this side authorized", () => {
  it("keeps a candidate at a Routes address the session named", () => {
    expect(kept(described("100.64.0.7"), ["100.64.0.7"])).toEqual([
      "100.64.0.7",
    ]);
  });

  it("drops the same candidate when nothing names it (the allowlist is what admits it)", () => {
    expect(kept(described("100.64.0.7"), [])).toEqual([]);
  });

  it("admits loopback by no default: only when this machine is named", () => {
    expect(kept(described("127.0.0.1", "::1"), [])).toEqual([]);
    expect(kept(described("127.0.0.1", "::1"), ["100.64.0.7"])).toEqual([]);
    expect(kept(described("127.0.0.1", "::1"), ["127.0.0.1"])).toEqual([
      "127.0.0.1",
    ]);
  });

  it("admits every address named, however many: own Routes and an allowed reply together", () => {
    const routes = Array.from(
      { length: NAMED_ADDRESSES_MAX },
      (_, at) => `100.64.0.${at + 1}`,
    );
    const allowed = Array.from(
      { length: NAMED_ADDRESSES_MAX },
      (_, at) => `100.64.1.${at + 1}`,
    );
    expect(
      kept(described(...routes, ...allowed), [...routes, ...allowed]),
    ).toEqual([...routes, ...allowed]);
  });

  it("drops an unnamed private, link-local, other loopback or mapped-private address", () => {
    expect(
      kept(
        described(
          "192.168.1.5",
          "10.0.0.7",
          "172.16.4.2",
          "169.254.169.254",
          "fe80::1",
          "127.0.0.2",
          "::ffff:192.168.1.5",
        ),
        ["100.64.0.7"],
      ),
    ).toEqual([]);
  });

  it("matches an address exactly: one octet off is dropped", () => {
    expect(kept(described("100.64.0.8"), ["100.64.0.7"])).toEqual([]);
    expect(kept(described("100.64.0.70"), ["100.64.0.7"])).toEqual([]);
  });

  it("compares IPv6 in canonical form", () => {
    expect(
      kept(described("fd7a:115c:a1e0::7"), ["fd7a:115c:a1e0:0:0:0:0:7"]),
    ).toEqual(["fd7a:115c:a1e0::7"]);
    expect(canonicalAddress("FD7A:115C:A1E0:0::7")).toBe("fd7a:115c:a1e0::7");
  });

  it("never resolves a host name: a named host admits no address", () => {
    expect(canonicalAddress("localhost")).toBeNull();
    expect(canonicalAddress("printer.lan")).toBeNull();
    expect(
      kept(described("192.168.1.5"), ["printer.lan", "localhost"]),
    ).toEqual([]);
  });
});

describe("a relay candidate at a TURN server the session names", () => {
  it("keeps a relay candidate at the literal host of a named TURN server", () => {
    expect(kept(relayed("10.0.0.5"), [], ["turn:10.0.0.5:3478"])).toEqual([
      "10.0.0.5",
    ]);
    expect(
      kept(relayed("10.0.0.5"), [], ["turns:10.0.0.5:5349?transport=tcp"]),
    ).toEqual(["10.0.0.5"]);
  });

  it("drops the same candidate when no TURN server names it (the allowlist is what admits it)", () => {
    expect(kept(relayed("10.0.0.5"), [])).toEqual([]);
    expect(kept(relayed("10.0.0.5"), [], ["stun:10.0.0.5:3478"])).toEqual([]);
  });

  it("admits only a relay candidate there, never a host candidate", () => {
    expect(kept(described("10.0.0.5"), [], ["turn:10.0.0.5:3478"])).toEqual([]);
  });

  it("matches the TURN host exactly, and compares IPv6 canonically", () => {
    expect(kept(relayed("10.0.0.6"), [], ["turn:10.0.0.5:3478"])).toEqual([]);
    expect(
      kept(
        relayed("fd7a:115c:a1e0::5"),
        [],
        ["turn:[fd7a:115c:a1e0:0:0:0:0:5]:3478?transport=udp"],
      ),
    ).toEqual(["fd7a:115c:a1e0::5"]);
  });

  it("never resolves a TURN host name: it admits no address", () => {
    expect(
      kept(relayed("10.0.0.5"), [], ["turn:turn.example.lan:3478"]),
    ).toEqual([]);
    expect(
      turnServerHosts([
        {
          urls: [
            "turn:turn.example.lan:3478",
            "turn:10.0.0.5:3478?transport=tcp",
            "turn:10.0.0.5",
            "stun:10.0.0.7",
            "turn:10.0.0.8:port",
            "turn:fd7a::5:3478",
          ],
        },
      ]),
    ).toEqual(["10.0.0.5"]);
  });
});

describe("the owner's reply names its Routes addresses", () => {
  it("carries the canonical Routes addresses, and none on a relay seat", () => {
    const base = { id: ID, answer: "v=0" };
    expect(
      withNamedAddresses(base, ["fd7a:115c:a1e0:0:0:0:0:7", "100.64.0.7"]),
    ).toEqual({ ...base, addresses: ["fd7a:115c:a1e0::7", "100.64.0.7"] });
    expect(withNamedAddresses(base, [])).toEqual(base);
    expect(
      withNamedAddresses({ id: ID, answer: "", relay: "nats" }, ["100.64.0.7"]),
    ).toEqual({ id: ID, answer: "", relay: "nats" });
  });

  it("is read with its addresses, which admit their candidates once allowed", () => {
    const read = reply({ addresses: ["100.64.0.7"] });
    expect(read?.addresses).toEqual(["100.64.0.7"]);
    expect(kept(described("100.64.0.7"), read?.addresses ?? [])).toEqual([
      "100.64.0.7",
    ]);
  });

  it("an older reply, without addresses, admits nothing non-public", () => {
    const read = reply({});
    expect(read).not.toBeNull();
    expect(read?.addresses).toBeUndefined();
    expect(
      kept(described("100.64.0.7", "127.0.0.1"), read?.addresses ?? []),
    ).toEqual([]);
  });

  it("names at most eight of the owner's Routes in a reply", () => {
    const routes = Array.from(
      { length: NAMED_ADDRESSES_MAX + 2 },
      (_, at) => `100.64.0.${at + 1}`,
    );
    const named = withNamedAddresses({ id: ID, answer: "v=0" }, routes);
    expect(named.addresses).toEqual(routes.slice(0, NAMED_ADDRESSES_MAX));
  });

  it("refuses a reply whose addresses are not a short list of canonical IP literals", () => {
    const tooMany = Array.from(
      { length: NAMED_ADDRESSES_MAX + 1 },
      (_, at) => `100.64.0.${at + 1}`,
    );
    expect(reply({ addresses: "100.64.0.7" })).toBeNull();
    expect(reply({ addresses: tooMany })).toBeNull();
    expect(reply({ addresses: ["printer.lan"] })).toBeNull();
    expect(reply({ addresses: ["fd7a:115c:a1e0:0:0:0:0:7"] })).toBeNull();
    expect(reply({ addresses: ["224.0.0.251"] })).toBeNull();
    expect(reply({ addresses: ["010.0.0.1"] })).toBeNull();
  });
});
