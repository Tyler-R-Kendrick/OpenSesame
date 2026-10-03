/**
 * What an installation lets a carrier do (ADR 0150 §7), against plans the
 * real resolver made from the shipped catalog: the capability must be
 * approved, external services allowed, and — under a narrowed policy — the
 * carrier's own origin listed, a `wss://` one for a WebSocket.
 */

import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import type { CarrierSpec } from "@opensesame/app-core/lib/live/transport.js";
import { localNetworkFetchSeams } from "@opensesame/app-core/lib/local-network-fetch.js";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY,
  CARRIER_META,
  CARRIER_PURPOSE,
  carrierAllowed,
  carrierRefusal,
} from "./allowed.js";
import { ALLOW_ALL, gateFor, planUnder, policy } from "./plan-kit.js";

const nostr = (url: string): CarrierSpec => ({ kind: "nostr", url });
const ntfy = (url: string): CarrierSpec => ({ kind: "ntfy", url });

describe("the declared purpose", () => {
  it("is the one the catalog declares for external services", () => {
    const declared = CAPABILITY_CATALOG.capabilities
      .find((d) => d.id === CAPABILITY)
      ?.egress.find((e) => e.class === "external-service");
    expect(declared?.purpose).toBe(CARRIER_PURPOSE);
    expect(CARRIER_META).toEqual({
      capability: CAPABILITY,
      purpose: CARRIER_PURPOSE,
    });
  });
});

describe("a WebSocket carrier (Nostr, MQTT, NATS)", () => {
  it("is allowed when the capability is approved and external services are allowed", () => {
    const gate = gateFor(planUnder(policy(ALLOW_ALL)));
    for (const kind of ["nostr", "mqtt", "nats"] as const)
      expect(
        carrierRefusal({ kind, url: "wss://relay.example.test" }, gate),
        kind,
      ).toBeNull();
  });

  it("under a narrowed policy needs its own wss:// origin listed", () => {
    const listed = gateFor(
      planUnder(
        policy({
          externalServices: "allow",
          allowedServiceOrigins: ["wss://relay.example.test:8443"],
        }),
      ),
    );
    expect(
      carrierRefusal(nostr("wss://relay.example.test:8443/x"), listed),
    ).toBeNull();
    expect(carrierRefusal(nostr("wss://relay.example.test"), listed)).toBe(
      "origin-not-allowed",
    );
    expect(carrierRefusal(nostr("wss://other.example.test:8443"), listed)).toBe(
      "origin-not-allowed",
    );
  });

  it("is not stood for by an https:// entry, which a CSP does not honour for a socket", () => {
    const gate = gateFor(
      planUnder(
        policy({
          externalServices: "allow",
          allowedServiceOrigins: ["https://relay.example.test"],
        }),
      ),
    );
    expect(carrierRefusal(nostr("wss://relay.example.test"), gate)).toBe(
      "origin-not-allowed",
    );
  });

  it("is refused when external services are off, whatever is listed", () => {
    const gate = gateFor(
      planUnder(
        policy({
          externalServices: "deny",
          allowedServiceOrigins: ["wss://relay.example.test"],
        }),
      ),
    );
    expect(carrierRefusal(nostr("wss://relay.example.test"), gate)).toBe(
      "external-services-denied",
    );
  });

  it("is refused when the person has not selected Live sessions, or the operator prohibits it", () => {
    const off = gateFor(planUnder(policy(ALLOW_ALL), false));
    expect(carrierRefusal(nostr("wss://relay.example.test"), off)).toBe(
      "capability-not-approved",
    );
    const prohibited = gateFor(planUnder(policy(ALLOW_ALL, [CAPABILITY])));
    expect(carrierRefusal(nostr("wss://relay.example.test"), prohibited)).toBe(
      "capability-not-approved",
    );
    expect(carrierAllowed(nostr("wss://relay.example.test"), prohibited)).toBe(
      false,
    );
  });

  it("is refused before a plan has resolved", () => {
    expect(
      carrierRefusal(nostr("wss://relay.example.test"), gateFor(null)),
    ).toBe("capability-not-approved");
  });

  it("is plain ws:// only on this device", () => {
    const gate = gateFor(planUnder(policy(ALLOW_ALL)));
    expect(carrierRefusal(nostr("ws://127.0.0.1:7777"), gate)).toBeNull();
    expect(carrierRefusal(nostr("ws://relay.example.test"), gate)).toBe(
      "unsupported-scheme",
    );
    expect(carrierRefusal(nostr("ws://100.64.0.1:7777"), gate)).toBe(
      "unsupported-scheme",
    );
  });
});

describe("an ntfy carrier, held to egress's own decision", () => {
  it("is allowed at a listed https origin and refused elsewhere", () => {
    const gate = gateFor(
      planUnder(
        policy({
          externalServices: "allow",
          allowedServiceOrigins: ["https://ntfy.example.test"],
        }),
      ),
    );
    expect(carrierRefusal(ntfy("https://ntfy.example.test"), gate)).toBeNull();
    expect(carrierRefusal(ntfy("https://ntfy.sh"), gate)).toBe(
      "origin-not-allowed",
    );
  });

  it("is refused when the capability is withdrawn or services are off", () => {
    expect(
      carrierRefusal(
        ntfy("https://ntfy.sh"),
        gateFor(planUnder(policy(ALLOW_ALL, [CAPABILITY]))),
      ),
    ).toBe("capability-not-approved");
    expect(
      carrierRefusal(
        ntfy("https://ntfy.sh"),
        gateFor(
          planUnder(
            policy({ externalServices: "deny", allowedServiceOrigins: [] }),
          ),
        ),
      ),
    ).toBe("external-services-denied");
  });

  it("reaches this device over plain http, and nothing else over it", () => {
    const eligible = localNetworkFetchSeams.eligible;
    localNetworkFetchSeams.eligible = () => true;
    try {
      const gate = gateFor(planUnder(policy(ALLOW_ALL)));
      expect(carrierRefusal(ntfy("http://127.0.0.1:8080"), gate)).toBeNull();
      expect(carrierRefusal(ntfy("http://ntfy.example.test"), gate)).toBe(
        "unsupported-scheme",
      );
    } finally {
      localNetworkFetchSeams.eligible = eligible;
    }
  });
});

describe("BroadcastChannel", () => {
  it("never leaves the browser, so no policy is asked", () => {
    expect(
      carrierRefusal(
        { kind: "broadcast", url: "" },
        gateFor(
          planUnder(
            policy({ externalServices: "deny", allowedServiceOrigins: [] }),
          ),
        ),
      ),
    ).toBeNull();
  });
});
