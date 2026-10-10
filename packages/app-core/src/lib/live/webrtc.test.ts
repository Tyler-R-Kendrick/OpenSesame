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
import { rtcServers, webRtcTransport } from "./webrtc.js";

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
});
