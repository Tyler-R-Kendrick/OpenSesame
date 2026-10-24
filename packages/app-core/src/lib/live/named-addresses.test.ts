/**
 * The addresses a session names (ADR 0150 §6, amended 2026-10-24): a
 * received description keeps a candidate at a non-public literal only when
 * the address is exactly one the session named, and the owner's reply names
 * its Routes addresses for the one joiner it seals to.
 */
import { describe, expect, it } from "vitest";
import { readJoinReply } from "./messages.js";
import {
  NAMED_ADDRESSES_MAX,
  canonicalAddress,
  sessionNamedAddresses,
  withNamedAddresses,
} from "./named-addresses.js";
import { filterDataChannelSdp, isDataChannelSdp } from "./sdp.js";

const ID = "abcdefghijklmnopqrstuv";
const HEAD = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0"];
const MEDIA = "m=application 9 UDP/DTLS/SCTP webrtc-datachannel";

function described(...addresses: string[]): string {
  const lines = [...HEAD, MEDIA, "c=IN IP4 0.0.0.0", "a=mid:0"];
  addresses.forEach((address, at) => {
    lines.push(
      `a=candidate:${at + 1} 1 udp 2113937151 ${address} 54400 typ host`,
    );
  });
  return `${lines.join("\r\n")}\r\n`;
}

/** The addresses whose candidates survive the filter, in order. */
function kept(sdp: string, named: readonly string[]): string[] {
  const filtered = filterDataChannelSdp(sdp, sessionNamedAddresses(named));
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

describe("a received description keeps only what the session named", () => {
  it("keeps a candidate at a Routes address the session named", () => {
    expect(kept(described("100.64.0.7"), ["100.64.0.7"])).toEqual([
      "100.64.0.7",
    ]);
  });

  it("drops the same candidate when nothing names it (the allowlist is what admits it)", () => {
    expect(kept(described("100.64.0.7"), [])).toEqual([]);
  });

  it("keeps the same-machine defaults whatever else is named", () => {
    expect(kept(described("127.0.0.1", "::1"), [])).toEqual([
      "127.0.0.1",
      "::1",
    ]);
    expect(kept(described("127.0.0.1", "::1"), ["100.64.0.7"])).toEqual([
      "127.0.0.1",
      "::1",
    ]);
  });

  it("keeps the same-machine defaults beside a full list of Routes addresses", () => {
    const routes = Array.from(
      { length: NAMED_ADDRESSES_MAX },
      (_, at) => `100.64.0.${at + 1}`,
    );
    expect(kept(described("127.0.0.1", "::1", ...routes), routes)).toEqual([
      "127.0.0.1",
      "::1",
      ...routes,
    ]);
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

  it("is read with its addresses, which then admit their candidates", () => {
    const read = reply({ addresses: ["100.64.0.7"] });
    expect(read?.addresses).toEqual(["100.64.0.7"]);
    expect(kept(described("100.64.0.7"), read?.addresses ?? [])).toEqual([
      "100.64.0.7",
    ]);
  });

  it("an older reply, without addresses, admits only loopback", () => {
    const read = reply({});
    expect(read).not.toBeNull();
    expect(read?.addresses).toBeUndefined();
    expect(
      kept(described("100.64.0.7", "127.0.0.1"), read?.addresses ?? []),
    ).toEqual(["127.0.0.1"]);
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
