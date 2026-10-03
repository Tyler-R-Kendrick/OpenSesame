/**
 * A carrier the installation refuses is marked blocked, apart from one that
 * could not be reached (ADR 0150 §7); neither holds a session waiting.
 */

import { describe, expect, it } from "vitest";
import { CarrierBlocked, Rendezvous } from "./rendezvous.js";
import type { CarrierSpec } from "./transport.js";

const SECRET = "A".repeat(43);
const refused: CarrierSpec = { kind: "nostr", url: "wss://a.example.test" };
const down: CarrierSpec = { kind: "mqtt", url: "wss://b.example.test" };

describe("a refused carrier", () => {
  it("is blocked, not failed; only a CarrierBlocked makes it so", async () => {
    const rendezvous = Rendezvous.open(
      [refused, down],
      SECRET,
      async (spec) => {
        if (spec === refused) throw new CarrierBlocked("origin-not-allowed");
        throw new Error("unreachable");
      },
      () => {},
    );
    await rendezvous.whenReady(5000);
    expect(rendezvous.states.map((state) => state.status)).toEqual([
      "blocked",
      "failed",
    ]);
    rendezvous.close();
  });

  it("does not keep a first post waiting once every carrier is blocked or failed", async () => {
    const rendezvous = Rendezvous.open(
      [refused, down],
      SECRET,
      async (spec) => {
        if (spec === refused) throw new CarrierBlocked();
        throw new Error("unreachable");
      },
      () => {},
    );
    const started = Date.now();
    await rendezvous.whenReady(5000);
    expect(Date.now() - started).toBeLessThan(2000);
    rendezvous.close();
  });
});
