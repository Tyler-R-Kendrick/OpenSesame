import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { WATCH_RTC } from "./live-rtc.mjs";

afterEach(() => vi.unstubAllGlobals());

test("candidate diagnostics retain only routing metadata after a browser closes its peer", () => {
  class Peer extends EventTarget {
    signalingState = "have-remote-offer";
    remoteDescription = null;
  }
  class Channel extends EventTarget {
    send() {}
  }
  vi.stubGlobal("window", { RTCPeerConnection: Peer });
  vi.stubGlobal("RTCDataChannel", Channel);
  WATCH_RTC();
  const peer = new window.RTCPeerConnection({ iceServers: [] });
  const line =
    "candidate:fixture 1 udp 123 192.0.2.20 43210 typ host generation 0 ufrag omitted";
  const event = new Event("icecandidate");
  Object.defineProperty(event, "candidate", { value: { candidate: line } });
  peer.dispatchEvent(event);
  peer.remoteDescription = {
    sdp: `v=0\r\na=ice-pwd:never-log-this\r\na=${line}\r\n`,
  };
  peer.dispatchEvent(new Event("signalingstatechange"));
  peer.signalingState = "closed";
  Object.defineProperty(peer, "remoteDescription", {
    get() {
      throw new Error("Firefox does not expose closed descriptions");
    },
  });
  peer.dispatchEvent(new Event("signalingstatechange"));
  const fields = {
    protocol: "udp",
    address: "192.0.2.20",
    port: "43210",
    type: "host",
  };
  assert.deepEqual(window.__rtcCandidates, [
    { gathered: [fields], retained: [fields] },
  ]);
  assert.doesNotMatch(
    JSON.stringify(window.__rtcCandidates),
    /never-log-this|omitted|ufrag|ice-pwd/,
  );
});
