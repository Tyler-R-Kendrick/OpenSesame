/**
 * What a session description may say (ADR 0150 §3): a real browser's data
 * channel offer and answer read, and nothing that asks for more than that.
 * Everything goes through the readers of the sealed codes, which is where a
 * description comes in.
 */
import { describe, expect, it } from "vitest";
import capture from "./__fixtures__/chromium-sdp.json";
import others from "./__fixtures__/firefox-webkit-sdp.json";
import { withAddressHints } from "./candidates.js";
import { fakeSdp } from "./live-fakes.js";
import { readJoinReply, readJoinRequest } from "./messages.js";
import { isDataChannelSdp } from "./sdp.js";

const ID = "abcdefghijklmnopqrstuv";

function offer(sdp: string) {
  return readJoinRequest(
    JSON.stringify({ id: ID, name: "Ada", note: "", offer: sdp }),
    isDataChannelSdp,
  );
}

function answer(sdp: string) {
  return readJoinReply(
    JSON.stringify({ id: ID, answer: sdp }),
    isDataChannelSdp,
  );
}

/** A description made of `lines`, the way a browser ends each one. */
function sdp(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

const HEAD = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0"];
const MEDIA = "m=application 9 UDP/DTLS/SCTP webrtc-datachannel";
const GOOD = sdp(...HEAD, MEDIA, "c=IN IP4 0.0.0.0", "a=mid:0");
const CANDIDATE =
  "a=candidate:1 1 udp 2113937151 192.168.1.5 54400 typ host generation 0";

function withLines(...lines: string[]): string {
  return sdp(...HEAD, MEDIA, "c=IN IP4 0.0.0.0", ...lines);
}

describe("what real Chromium sends", () => {
  const pairs = capture.captures.flatMap((entry) =>
    entry.pairs.map((pair) => ({ ...pair, browser: entry.browser })),
  );

  it("was captured for both versions and all four road shapes", () => {
    expect(capture.captures).toHaveLength(2);
    expect(pairs.map((pair) => pair.name).sort()).toEqual(
      [
        "mdns-off",
        "mdns-on",
        "relay-only",
        "turn-and-stun",
        "mdns-off",
        "mdns-on",
        "relay-only",
        "turn-and-stun",
      ].sort(),
    );
  });

  for (const pair of pairs)
    it(`reads ${pair.browser} ${pair.name}: offer, answer, either line ending, with address hints`, () => {
      expect(offer(pair.offer)?.offer).toBe(pair.offer);
      expect(answer(pair.answer)?.answer).toBe(pair.answer);
      expect(offer(pair.offer.replace(/\r\n/g, "\n"))).not.toBeNull();
      const hints = [
        "100.101.102.103",
        "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240",
      ];
      expect(offer(withAddressHints(pair.offer, hints))).not.toBeNull();
      expect(answer(withAddressHints(pair.answer, hints))).not.toBeNull();
    });
});

describe("what real Firefox and WebKit send", () => {
  const pairs = others.captures.flatMap((entry) =>
    entry.pairs.map((pair) => ({ ...pair, browser: entry.browser })),
  );
  const engine = (browser: string) =>
    browser.includes("Firefox/") ? "Firefox" : "WebKit";

  it("was captured for both engines and all four road shapes, and each answering the others", () => {
    expect(others.captures.map((entry) => engine(entry.browser))).toEqual([
      "Firefox",
      "WebKit",
    ]);
    for (const entry of others.captures)
      expect(entry.pairs.map((pair) => pair.name).sort()).toEqual(
        ["mdns-off", "mdns-on", "relay-only", "turn-and-stun"].sort(),
      );
    expect(
      others.cross.map((pair) => `${pair.offerer}>${pair.answerer}`).sort(),
    ).toEqual(
      [
        "chromium>firefox",
        "chromium>webkit",
        "firefox>chromium",
        "firefox>webkit",
        "webkit>chromium",
        "webkit>firefox",
      ].sort(),
    );
    // The relay roads gathered relay candidates: they are not empty captures.
    const relayOnly = pairs.filter((pair) => pair.name === "relay-only");
    for (const pair of relayOnly) {
      expect(pair.offer).toContain("typ relay");
      expect(pair.offer).not.toContain("typ host");
    }
  });

  for (const pair of pairs)
    it(`reads ${engine(pair.browser)} ${pair.name}: offer, answer, either line ending, with address hints`, () => {
      expect(offer(pair.offer)?.offer).toBe(pair.offer);
      expect(answer(pair.answer)?.answer).toBe(pair.answer);
      expect(offer(pair.offer.replace(/\r\n/g, "\n"))).not.toBeNull();
      const hints = [
        "100.101.102.103",
        "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240",
      ];
      expect(offer(withAddressHints(pair.offer, hints))).not.toBeNull();
      expect(answer(withAddressHints(pair.answer, hints))).not.toBeNull();
    });

  for (const pair of others.cross)
    it(`reads ${pair.answerer}'s answer to ${pair.offerer}'s offer`, () => {
      expect(offer(pair.offer)?.offer).toBe(pair.offer);
      expect(answer(pair.answer)?.answer).toBe(pair.answer);
    });
});

describe("what other browsers send", () => {
  // Written from the shape Firefox and Safari's WebRTC stacks use for a data
  // channel, beside the captures above: an srflx candidate, an IPv6 one and
  // Safari's mDNS names, which a capture on one machine with no STUN lacks.
  const FIREFOX = sdp(
    "v=0",
    "o=mozilla...THIS_IS_SDPARTA-99.0 5175827427628424404 0 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=sendrecv",
    "a=fingerprint:sha-256 0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9",
    "a=group:BUNDLE 0",
    "a=ice-options:trickle",
    "a=msid-semantic:WMS *",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=candidate:0 1 UDP 2122252543 192.168.1.5 55555 typ host",
    "a=candidate:1 1 TCP 2105458943 192.168.1.5 9 typ host tcptype active",
    "a=candidate:2 1 UDP 1686052863 203.0.113.9 55555 typ srflx raddr 192.168.1.5 rport 55555",
    "a=sendrecv",
    "a=end-of-candidates",
    "a=ice-pwd:0123456789abcdef0123456789abcdef",
    "a=ice-ufrag:abcd1234",
    "a=mid:0",
    "a=setup:actpass",
    "a=sctp-port:5000",
    "a=max-message-size:1073741823",
  );
  const SAFARI = sdp(
    "v=0",
    "o=- 8446181834552383836 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=candidate:2833432121 1 udp 2113937151 4f2e9f5a-0c1d-4c5e-9d0e-0a1b2c3d4e5f.local 54400 typ host generation 0 ufrag abcd network-cost 999",
    "a=candidate:842163049 1 udp 1686052607 2001:db8::1 54400 typ srflx raddr :: rport 0 generation 0 ufrag abcd network-id 1 network-cost 50",
    "a=ice-ufrag:abcd",
    "a=ice-pwd:0123456789abcdef01234567",
    "a=fingerprint:sha-256 0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9",
    "a=setup:actpass",
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  );
  const LEGACY = sdp(
    ...HEAD,
    "m=application 9 DTLS/SCTP 5000",
    "c=IN IP4 0.0.0.0",
    "a=sctpmap:5000 webrtc-datachannel 1024",
    "a=setup:active",
  );

  it("reads Firefox's, Safari's and the legacy numeric format", () => {
    expect(offer(FIREFOX)).not.toBeNull();
    expect(offer(SAFARI)).not.toBeNull();
    expect(answer(LEGACY)).not.toBeNull();
    expect(offer(GOOD)).not.toBeNull();
    expect(offer(fakeSdp())).not.toBeNull();
  });

  it("lets an attribute nobody here has met through, if it is shaped like one", () => {
    expect(
      offer(withLines("a=x-vendor-thing:1 2 3", "a=flag-only")),
    ).not.toBeNull();
    expect(offer(withLines("a=Not_An_Attribute:1"))).toBeNull();
    expect(offer(withLines(`a=x-long:${"a".repeat(600)}`))).toBeNull();
  });
});

describe("what is refused", () => {
  const refused = (text: string) => expect(offer(text)).toBeNull();

  it("anything that is not one data-channel section", () => {
    refused("v=0");
    refused("v=0\r\n");
    refused("hello");
    refused(sdp(...HEAD));
    // Another section: audio, video, a second data channel.
    refused(sdp(...HEAD, "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0"));
    refused(sdp(...HEAD, MEDIA, "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1"));
    refused(sdp(...HEAD, MEDIA, MEDIA));
    refused(sdp(...HEAD, "m=application 9 UDP/TLS/RTP/SAVPF 96"));
    refused(sdp(...HEAD, "m=application 9 UDP/DTLS/SCTP webrtc-datachannel x"));
    refused(
      sdp(...HEAD, "m=application 70000 UDP/DTLS/SCTP webrtc-datachannel"),
    );
    // A line that is not a line of a description, or is out of place.
    refused(sdp(...HEAD, MEDIA, "x=whatever"));
    refused(sdp(...HEAD, MEDIA, "k=clear:secret"));
    refused(sdp("v=0", "s=-", "t=0 0", MEDIA));
    refused(sdp("v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", MEDIA, "t=0 0"));
    refused(sdp(...HEAD, "t=0 0", MEDIA));
    refused(sdp("v=1", ...HEAD.slice(1), MEDIA));
  });

  it("text a description is not made of", () => {
    refused(withLines("a=mid:0\u0000"));
    refused(withLines("a=mid:é"));
    refused(sdp(...HEAD, MEDIA, "", "a=mid:0"));
    refused(`${GOOD}a=mid:0\r`);
    refused(`${GOOD}${"a=x-a:b\r\n".repeat(400)}`);
    refused(`${GOOD}${"a=x-a:".padEnd(48 * 1024, "b")}`);
  });

  it("an address that is not an IP or an mDNS name, and a bad candidate", () => {
    const bad = (line: string) => refused(withLines(line));
    bad("a=candidate:1 1 udp 2113937151 evil.example.com 54400 typ host");
    bad("a=candidate:1 1 udp 2113937151 localhost 54400 typ host");
    bad("a=candidate:1 1 udp 2113937151 0.0.0.0 54400 typ host");
    bad("a=candidate:1 1 udp 2113937151 224.0.0.1 54400 typ host");
    bad("a=candidate:1 1 udp 2113937151 999.1.1.1 54400 typ host");
    bad("a=candidate:1 1 udp 2113937151 not-a-uuid.local 54400 typ host");
    bad("a=candidate:1 1 udp 2113937151 192.168.1.5 0 typ host");
    bad("a=candidate:1 1 udp 2113937151 192.168.1.5 70000 typ host");
    bad("a=candidate:1 1 udp 2113937151 192.168.1.5 54400 typ weird");
    bad("a=candidate:1 1 udp 2113937151 192.168.1.5 54400 host");
    bad("a=candidate:1 1 sctp 2113937151 192.168.1.5 54400 typ host");
    bad("a=candidate:1 3 udp 2113937151 192.168.1.5 54400 typ host");
    bad("a=candidate:1 1 udp 99999999999 192.168.1.5 54400 typ host");
    bad("a=candidate:1 1 udp 2113937151 192.168.1.5 54400 typ host generation");
    bad(
      "a=candidate:1 1 udp 2113937151 192.168.1.5 54400 typ srflx raddr evil.example.com rport 1",
    );
    bad(
      "a=candidate:1 1 udp 2113937151 192.168.1.5 54400 typ srflx raddr 10.0.0.1 rport 99999",
    );
    bad("a=candidate:1 1 udp  2113937151 192.168.1.5 54400 typ host");
    bad("a=candidate");
    bad("a=candidate:");
    bad("a=remote-candidates:1 192.168.1.5 54400");
    bad("a=end-of-candidates:now");
    bad("a=setup:sideways");
    bad("a=ice-ufrag:x");
    bad("a=fingerprint:sha-256 nothex");
    bad("a=sctp-port:abc");
    // Addresses in the connection line are IP literals too.
    refused(sdp(...HEAD, MEDIA, "c=IN IP4 evil.example.com"));
    refused(
      sdp(
        ...HEAD,
        MEDIA,
        "c=IN IP4 0.0.0.0",
        "c=IN IP4 0.0.0.0",
        "c=IN IP4 0.0.0.0",
      ),
    );
  });

  it("more candidates than a browser gathers", () => {
    const many = (count: number) =>
      withLines(
        ...Array.from(
          { length: count },
          (_, at) =>
            `a=candidate:${at} 1 udp 2113937151 10.0.${Math.floor(at / 250)}.${(at % 250) + 1} ${54400 + at} typ host`,
        ),
      );
    expect(offer(many(128))).not.toBeNull();
    expect(offer(many(129))).toBeNull();
    expect(offer(withLines(CANDIDATE))).not.toBeNull();
  });

  it("an answer is read the same way", () => {
    expect(answer(GOOD)).not.toBeNull();
    expect(answer(sdp(...HEAD, "m=audio 9 RTP/AVP 0"))).toBeNull();
    expect(
      answer(withLines("a=candidate:1 1 udp 1 evil.example.com 5 typ host")),
    ).toBeNull();
  });
});
