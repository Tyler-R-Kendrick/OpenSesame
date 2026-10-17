import { describe, expect, it } from "vitest";
import {
  candidateKindsFromSdp,
  explainIceFailure,
  mergeCandidateKinds,
} from "./ice-diagnostics.js";
import { DIRECT_ROUTING } from "./p2p.js";

const SAMPLE = [
  "v=0",
  "a=candidate:1 1 UDP 2130706431 192.168.1.2 54321 typ host",
  "a=candidate:2 1 UDP 1694498815 abc.local 54322 typ host",
  "a=candidate:3 1 UDP 1677729535 1.2.3.4 54323 typ srflx raddr 0.0.0.0 rport 0",
].join("\n");

describe("ice diagnostics", () => {
  it("counts host, srflx, relay, and mDNS-looking lines without addresses", () => {
    const kinds = candidateKindsFromSdp(SAMPLE);
    expect(kinds).toEqual({ host: 2, srflx: 1, relay: 0, mdns: 1 });
  });

  it("merges candidate kind totals", () => {
    const left = { host: 1, srflx: 0, relay: 0, mdns: 0 };
    const right = { host: 0, srflx: 2, relay: 1, mdns: 0 };
    expect(mergeCandidateKinds(left, right)).toEqual({
      host: 1,
      srflx: 2,
      relay: 1,
      mdns: 0,
    });
  });

  it("explains mDNS-only direct routing failures in plain language", () => {
    const reason = explainIceFailure(DIRECT_ROUTING, {
      host: 2,
      srflx: 0,
      relay: 0,
      mdns: 2,
    });
    expect(reason.code).toBe("mdns_only");
    expect(reason.message).toMatch(/mDNS|private/i);
  });

  it("explains relay-only without relay candidates", () => {
    const reason = explainIceFailure(
      { servers: [{ urls: ["turn:turn.example.com"] }], relay: true, addresses: [] },
      { host: 0, srflx: 0, relay: 0, mdns: 0 },
    );
    expect(reason.code).toBe("relay_missing");
  });
});
