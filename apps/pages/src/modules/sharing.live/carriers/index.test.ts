/** @vitest-environment node */
/**
 * The carrier factory (ADR 0150 §6–7): a carrier the installation does not
 * allow is refused before anything opens, and shown as blocked; one that
 * connects too late is closed, never leaked.
 */

import {
  type Carrier,
  CarrierBlocked,
  Rendezvous,
} from "@opensesame/app-core/lib/live/rendezvous.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_MS,
  carrierFactory,
  carriersUnavailable,
  withinConnect,
} from "./index.js";
import { ALLOW_ALL, gateFor, planUnder, policy } from "./plan-kit.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fakeCarrier() {
  const close = vi.fn();
  const carrier: Carrier = {
    post: async () => {},
    listen: () => () => {},
    close,
  };
  return { carrier, close };
}

describe("withinConnect", () => {
  it("resolves a carrier that arrives in time, and clears its timer", async () => {
    vi.useFakeTimers();
    const { carrier, close } = fakeCarrier();
    await expect(withinConnect(async () => carrier)).resolves.toBe(carrier);
    expect(vi.getTimerCount()).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });

  it("rejects on the budget, aborts what it began, and closes a carrier that arrives late", async () => {
    vi.useFakeTimers();
    const { carrier, close } = fakeCarrier();
    let arrive: (value: Carrier) => void = () => {};
    const given: AbortSignal[] = [];
    const opening = withinConnect(
      (s) =>
        new Promise<Carrier>((resolve) => {
          given.push(s);
          arrive = resolve;
        }),
    );
    const outcome = expect(opening).rejects.toThrow("carrier_timeout");
    await vi.advanceTimersByTimeAsync(CONNECT_MS);
    await outcome;
    expect(given[0]?.aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    // Nobody holds it now: the caller was told it failed. It must not leak.
    arrive(carrier);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("passes on a failure that comes in time, and ignores one that comes late", async () => {
    vi.useFakeTimers();
    await expect(
      withinConnect(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    let fail: (error: Error) => void = () => {};
    const opening = withinConnect(
      () =>
        new Promise<Carrier>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const outcome = expect(opening).rejects.toThrow("carrier_timeout");
    await vi.advanceTimersByTimeAsync(CONNECT_MS);
    await outcome;
    fail(new Error("too late to matter"));
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("carrierFactory", () => {
  const socket = (kind: "nostr" | "mqtt" | "nats"): CarrierSpec => ({
    kind,
    url: "wss://relay.example.test",
  });

  it("refuses a carrier the plan does not allow as blocked, before any socket or request", async () => {
    const webSocket = vi.fn();
    vi.stubGlobal("WebSocket", webSocket);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("x"));
    const withdrawn = gateFor(planUnder(policy(ALLOW_ALL), false), fetchImpl);
    const factory = carrierFactory(withdrawn);
    for (const spec of [
      socket("nostr"),
      socket("mqtt"),
      socket("nats"),
      { kind: "ntfy", url: "https://ntfy.example.test" } as const,
    ])
      await expect(factory(spec, "topic")).rejects.toBeInstanceOf(
        CarrierBlocked,
      );
    expect(webSocket).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an origin a narrowed policy does not list, naming why", async () => {
    const gate = gateFor(
      planUnder(
        policy({
          externalServices: "allow",
          allowedServiceOrigins: ["wss://relay.other.test"],
        }),
      ),
    );
    await expect(carrierFactory(gate)(socket("nostr"), "t")).rejects.toThrow(
      "origin-not-allowed",
    );
  });

  it("opens BroadcastChannel whatever the policy", async () => {
    const gate = gateFor(
      planUnder(
        policy({ externalServices: "deny", allowedServiceOrigins: [] }),
      ),
    );
    const carrier = await carrierFactory(gate)(
      { kind: "broadcast", url: "" },
      "t",
    );
    carrier.close();
  });

  it("gives a session nothing while the capability is not active", async () => {
    await expect(
      carriersUnavailable({ kind: "broadcast", url: "" }, "t"),
    ).rejects.toBeInstanceOf(CarrierBlocked);
  });
});

describe("a session's view of a refused carrier", () => {
  it("is blocked, not failed, and the other carriers carry on", async () => {
    const gate = gateFor(
      planUnder(
        policy({
          externalServices: "allow",
          allowedServiceOrigins: ["wss://allowed.example.test"],
        }),
      ),
    );
    const allowed: CarrierSpec = {
      kind: "broadcast",
      url: "",
    };
    const refused: CarrierSpec = {
      kind: "nostr",
      url: "wss://relay.example.test",
    };
    const broken: CarrierSpec = {
      kind: "mqtt",
      url: "wss://allowed.example.test",
    };
    const real = carrierFactory(gate);
    const rendezvous = Rendezvous.open(
      [allowed, refused, broken],
      // 32 bytes, base64url.
      "A".repeat(43),
      (spec, topic) =>
        spec.kind === "mqtt"
          ? Promise.reject(new Error("down"))
          : real(spec, topic),
      () => {},
    );
    await vi.waitFor(() =>
      expect(rendezvous.states.map((s) => s.status)).toEqual([
        "ready",
        "blocked",
        "failed",
      ]),
    );
    rendezvous.close();
  });
});
