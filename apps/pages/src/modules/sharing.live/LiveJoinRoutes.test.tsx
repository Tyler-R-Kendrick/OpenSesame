/** @vitest-environment jsdom */
/**
 * Where each carrier stands, as the person sees it (ADR 0150 §7): a carrier
 * this installation refuses is "Blocked by this installation", not
 * "Unreachable" — the server did nothing wrong, and nothing was contacted.
 */

import {
  CarrierBlocked,
  type CarrierState,
  Rendezvous,
} from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CarrierMarks, carrierStanding } from "./LiveJoinRoutes.js";

afterEach(cleanup);

const relay: CarrierSpec = { kind: "nostr", url: "wss://relay.example.test" };

function state(status: CarrierState["status"]): CarrierState {
  return { spec: relay, status };
}

describe("carrierStanding", () => {
  it("says blocked by this installation, with the host, in its own tone", () => {
    expect(carrierStanding(state("blocked"))).toEqual({
      tone: "warn",
      label: "Blocked by this installation: relay.example.test",
      tray: "Blocked by this installation: relay.example.test",
    });
  });

  it("keeps unreachable for a carrier that could not be reached", () => {
    expect(carrierStanding(state("failed"))).toEqual({
      tone: "err",
      label: "Unreachable: relay.example.test (nostr)",
      tray: "Unreachable: relay.example.test (nostr)",
    });
    expect(carrierStanding(state("ready")).tone).toBe("ok");
    expect(carrierStanding(state("connecting")).tone).toBe("idle");
  });
});

describe("CarrierMarks", () => {
  it("draws a refused carrier as blocked and a failed one as unreachable", async () => {
    const down: CarrierSpec = { kind: "mqtt", url: "wss://mqtt.example.test" };
    const rendezvous = Rendezvous.open(
      [relay, down],
      "A".repeat(43),
      async (spec) => {
        if (spec.kind === "nostr")
          throw new CarrierBlocked("origin-not-allowed");
        throw new Error("connection refused");
      },
      () => {},
    );
    render(<CarrierMarks rendezvous={rendezvous} />);
    expect(
      await screen.findByRole("img", {
        name: "Blocked by this installation: relay.example.test",
      }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("img", {
        name: "Unreachable: mqtt.example.test (mqtt)",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Unreachable: relay/)).toBeNull();
    rendezvous.close();
  });
});
