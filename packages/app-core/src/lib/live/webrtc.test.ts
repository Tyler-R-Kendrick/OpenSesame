/**
 * WebRTC as a `PeerTransport` (ADR 0186): what the adapter promises the
 * session above it, against a fake `RTCPeerConnection`.
 *
 * - The data channel is read from the moment it exists: a frame that reaches
 *   this side before its own `open` handler ran is held for the reader.
 * - Whatever reaches `setRemoteDescription` has been read strictly.
 * - A link closed before the two meet says so to whoever waits on it, and a
 *   failed route is told once, never after the link was closed.
 */
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { FakeNet, fakeSdp } from "./live-fakes.js";
import type { ChannelMessage } from "./messages.js";
import { DIRECT_ROUTING } from "./p2p.js";
import {
  assertRoutableIceServers,
  rtcServers,
  webRtcTransport,
} from "./webrtc.js";

class Channel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
}

function fakePeer(channel: Channel): RTCPeerConnection {
  const peer = {
    iceGatheringState: "complete",
    localDescription: { sdp: "v=0\r\n" },
    createDataChannel: () => channel,
    createOffer: async () => ({ type: "offer", sdp: "v=0\r\n" }),
    setLocalDescription: async () => undefined,
    addEventListener: () => undefined,
  };
  // Only the members dialing touches.
  const pc: RTCPeerConnection = overlapCast(peer);
  return pc;
}

/** A peer that records each remote description it is handed. */
function recordingPeer(seen: string[]): RTCPeerConnection {
  const peer = {
    iceGatheringState: "complete",
    localDescription: { sdp: "v=0\r\n" },
    createDataChannel: () => new Channel(),
    createOffer: async () => ({ type: "offer", sdp: "v=0\r\n" }),
    createAnswer: async () => ({ type: "answer", sdp: "v=0\r\n" }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async ({ sdp }: { sdp: string }) => {
      seen.push(sdp);
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: () => undefined,
  };
  // Only the members answering and accepting touch.
  const pc: RTCPeerConnection = overlapCast(peer);
  return pc;
}

/** A description with one candidate of `type` at `address`. */
function candidateAt(
  address: string,
  type: "host" | "relay" = "relay",
): string {
  const tail = type === "relay" ? " raddr 0.0.0.0 rport 0" : "";
  return [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    `a=candidate:1 1 udp 41885439 ${address} 50000 typ ${type}${tail}`,
    "",
  ].join("\r\n");
}

const relayAt = (address: string) => candidateAt(address, "relay");
const hostAt = (address: string) => candidateAt(address, "host");

/** Whether each remote description handed over kept a candidate at `at`. */
const keptAt = (seen: readonly string[], at: string) =>
  seen.map((sdp) => sdp.includes(` ${at} 50000 `));

const TURN_ROUTING = {
  ...DIRECT_ROUTING,
  servers: [{ urls: ["turn:10.0.0.5:3478"] }],
};

const CATALOG: ChannelMessage = {
  t: "catalog",
  catalog: { title: "Team", policy: "read", expiresAt: 1, items: [] },
};

describe("the WebRTC transport", () => {
  it("keeps a frame that arrives before its open event, for the reader", async () => {
    const channel = new Channel();
    const transport = webRtcTransport(() => fakePeer(channel), DIRECT_ROUTING);
    const link = await transport.dial();
    // Blink may dispatch the first message before this side's open.
    channel.dispatchEvent(
      Object.assign(new Event("message"), { data: JSON.stringify(CATALOG) }),
    );
    channel.readyState = "open";
    channel.dispatchEvent(new Event("open"));
    const peer = await link.channel;
    const heard: ChannelMessage[] = [];
    peer.onMessage((message) => heard.push(message));
    expect(heard).toEqual([CATALOG]);
  });

  it("reads a handshake strictly, and never hands the browser one it refused", async () => {
    const net = new FakeNet();
    const transport = net.transport();
    expect(transport.readsOffer(fakeSdp())).toBe(true);
    expect(transport.readsOffer("m=audio 9 UDP/TLS/RTP/SAVPF 111")).toBe(false);
    await expect(transport.answer("not a description")).rejects.toThrow(
      "bad_offer",
    );
    // Refused before a connection was made for it.
    expect(net.created).toBe(0);
    const link = await transport.dial();
    await expect(link.accept("v=0\r\nm=video 9 RTP 96\r\n")).rejects.toThrow(
      "bad_answer",
    );
    link.close();
  });

  it("tells whoever waits that a link closed before the two met", async () => {
    const net = new FakeNet();
    const link = await net.transport().dial();
    const waiting = link.channel.then(
      () => "open",
      (error: Error) => error.message,
    );
    link.close();
    link.close();
    expect(await waiting).toMatch(/link_closed|channel_closed/);
    expect(net.peers[0]?.closed).toBe(true);
  });

  it("tells a failed route once, and not after the link was closed", async () => {
    const net = new FakeNet();
    net.unreachable = true;
    const transport = net.transport();
    const dialed = await transport.dial();
    const answered = await transport.answer(dialed.handshake);
    let failures = 0;
    dialed.onFailed(() => {
      failures += 1;
    });
    dialed.channel.catch(() => undefined);
    answered.channel.catch(() => undefined);
    await dialed.accept(answered.handshake);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures).toBe(1);
    dialed.close();
    let late = 0;
    dialed.onFailed(() => {
      late += 1;
    });
    expect(late).toBe(0);
    answered.close();
  });

  it("hands the browser a relay candidate at its own TURN server's literal host, on both sides", async () => {
    const seen: string[] = [];
    const owner = webRtcTransport(() => recordingPeer(seen), TURN_ROUTING);
    (await owner.answer(relayAt("10.0.0.5"))).close();
    const joiner = webRtcTransport(() => recordingPeer(seen), TURN_ROUTING);
    const link = await joiner.dial();
    await link.accept(relayAt("10.0.0.5"));
    link.close();
    expect(keptAt(seen, "10.0.0.5")).toEqual([true, true]);
  });

  it("drops that relay candidate where this side names no TURN server there", async () => {
    const seen: string[] = [];
    const owner = webRtcTransport(() => recordingPeer(seen), DIRECT_ROUTING);
    (await owner.answer(relayAt("10.0.0.5"))).close();
    const link = await webRtcTransport(
      () => recordingPeer(seen),
      DIRECT_ROUTING,
    ).dial();
    await link.accept(relayAt("10.0.0.5"));
    link.close();
    expect(keptAt(seen, "10.0.0.5")).toEqual([false, false]);
  });

  it("hands the browser a reply-named address only once the person allowed it", async () => {
    const seen: string[] = [];
    const transport = webRtcTransport(
      () => recordingPeer(seen),
      DIRECT_ROUTING,
    );
    const declined = await transport.dial();
    await declined.accept(hostAt("100.64.0.7"), []);
    declined.close();
    const allowed = await transport.dial();
    await allowed.accept(hostAt("100.64.0.7"), ["100.64.0.7"]);
    allowed.close();
    expect(keptAt(seen, "100.64.0.7")).toEqual([false, true]);
  });

  it("admits loopback on the owner's side only when its Routes name this machine", async () => {
    const seen: string[] = [];
    const plain = webRtcTransport(() => recordingPeer(seen), DIRECT_ROUTING);
    (await plain.answer(hostAt("127.0.0.1"))).close();
    const here = webRtcTransport(() => recordingPeer(seen), {
      ...DIRECT_ROUTING,
      addresses: ["127.0.0.1"],
    });
    (await here.answer(hostAt("127.0.0.1"))).close();
    expect(keptAt(seen, "127.0.0.1")).toEqual([false, true]);
  });

  it("passes the owner's servers to the browser without empty credentials", () => {
    expect(
      rtcServers([
        { urls: ["stun:stun.example.com"], username: "", credential: "" },
        { urls: ["turn:turn.example.com"], username: "u", credential: "c" },
      ]),
    ).toEqual([
      { urls: ["stun:stun.example.com"] },
      { urls: ["turn:turn.example.com"], username: "u", credential: "c" },
    ]);
  });

  it("refuses ICE servers aimed at loopback, link-local or metadata", () => {
    for (const urls of [
      ["stun:127.0.0.1"],
      ["turn:localhost:3478"],
      ["stun:[::1]:3478"],
      ["stun:169.254.169.254"],
      ["turn:[::ffff:127.0.0.1]"],
      ["stun:metadata.google.internal"],
    ]) {
      expect(() => assertRoutableIceServers([{ urls }])).toThrow(
        /ice_server_blocked/,
      );
    }
    expect(() =>
      assertRoutableIceServers([
        { urls: ["stun:stun.example.com:3478", "turn:10.0.0.5:3478"] },
      ]),
    ).not.toThrow();
  });
});
