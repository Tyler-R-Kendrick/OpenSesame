/**
 * The joiner's side at the edges (ADR 0150 §3): leaving before there is an
 * offer to leave with must not strand a peer connection.
 */
import { describe, expect, it } from "vitest";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { deferred, settle } from "./live-clock.fixture.js";
import { FakeNet } from "./live-fakes.js";
import { DIRECT_ONLY } from "./peer.js";

async function host(net: FakeNet): Promise<LiveHost> {
  return LiveHost.start({
    admission: "open",
    ice: DIRECT_ONLY,
    expiresAt: Date.now() + 60_000,
    catalog: () => ({ title: "T", policy: "read", expiresAt: 1, items: [] }),
    readField: async () => null,
    peers: net.factory(),
  });
}

describe("leaving while the offer is being made", () => {
  it("closes the connection the browser was still making, and makes no request", async () => {
    const net = new FakeNet();
    const owner = await host(net);
    const hold = deferred();
    net.holdOffer = hold.promise;
    const guest = new LiveGuest({
      link: owner.link,
      code: null,
      name: "Ada",
      note: "",
      ice: DIRECT_ONLY,
      peers: net.factory(),
    });
    const starting = guest.start();
    // The peer exists, but its real offer is still held.
    await settle(10);
    expect(net.peers).toHaveLength(1);
    guest.leave();
    hold.release();
    expect(await starting).toBe("");
    expect(guest.status).toEqual({ at: "ended" });
    expect(net.peers).toHaveLength(1);
    expect(net.peers[0]?.closed).toBe(true);
    owner.end();
  });
});
