/**
 * The joiner's side at the edges (ADR 0150 §3): leaving before there is an
 * offer to leave with must not strand a peer connection.
 */
import { describe, expect, it } from "vitest";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { deferred } from "./live-clock.fixture.js";
import { FakeNet } from "./live-fakes.js";

async function host(net: FakeNet): Promise<LiveHost> {
  return LiveHost.start({
    admission: "open",
    expiresAt: Date.now() + 60_000,
    catalog: () => ({ title: "T", policy: "read", expiresAt: 1, items: [] }),
    readField: async () => null,
    transport: net.transport(),
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
      transport: net.transport(),
    });
    const starting = guest.start();
    // Left before the browser had an offer: nothing to close yet.
    guest.leave();
    hold.release();
    expect(await starting).toBe("");
    expect(guest.status).toEqual({ at: "ended" });
    expect(net.peers).toHaveLength(1);
    expect(net.peers[0]?.closed).toBe(true);
    owner.end();
  });
});
