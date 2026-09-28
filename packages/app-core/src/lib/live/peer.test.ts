/**
 * The data channel is read from the moment it exists (ADR 0148 §5): the
 * other side sends the catalog as soon as its end opens, and a frame that
 * reaches this side before its own `open` handler ran must not be lost —
 * the owner would count in a joiner who never saw what is shared.
 */
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { ChannelMessage } from "./messages.js";
import { DIRECT_ONLY, makeOffer } from "./peer.js";

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
  };
  // Only the members makeOffer touches.
  const pc: RTCPeerConnection = overlapCast(peer);
  return pc;
}

const CATALOG: ChannelMessage = {
  t: "catalog",
  catalog: { title: "Team", policy: "read", expiresAt: 1, items: [] },
};

describe("a peer channel", () => {
  it("keeps a frame that arrives before its open event, for the reader", async () => {
    const channel = new Channel();
    const side = await makeOffer(() => fakePeer(channel), DIRECT_ONLY);
    // Blink may dispatch the first message before this side's open.
    channel.dispatchEvent(
      Object.assign(new Event("message"), { data: JSON.stringify(CATALOG) }),
    );
    channel.readyState = "open";
    channel.dispatchEvent(new Event("open"));
    const peer = await side.channel;
    const heard: ChannelMessage[] = [];
    peer.onMessage((message) => heard.push(message));
    expect(heard).toEqual([CATALOG]);
  });
});
