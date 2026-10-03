/**
 * What the plan says about a carrier (ADR 0150 §7), including that a page on
 * the shared origin may not reach this device or a LAN through one, whichever
 * way it asks: the rule egress already applies to http.
 */
import { afterEach, describe, expect, it } from "vitest";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { planRefusal } from "./carrier-policy.js";
import { plan } from "./live-plan.fixture.js";

const allowed = plan(true, false, {
  externalServices: "allow",
  allowedServiceOrigins: [],
});
const original = localNetworkFetchSeams.eligible;
afterEach(() => {
  localNetworkFetchSeams.eligible = original;
});

describe("a socket carrier on this device or a LAN", () => {
  it("is refused where the deployment may not pair local authority", () => {
    localNetworkFetchSeams.eligible = () => false;
    expect(
      planRefusal({ kind: "nostr", url: "ws://127.0.0.1:7777" }, allowed),
    ).toBe("local-authority-not-permitted");
    expect(
      planRefusal({ kind: "mqtt", url: "wss://192.168.1.20:9001" }, allowed),
    ).toBe("local-authority-not-permitted");
  });

  it("is allowed on a deployment of one's own", () => {
    localNetworkFetchSeams.eligible = () => true;
    expect(
      planRefusal({ kind: "nostr", url: "ws://127.0.0.1:7777" }, allowed),
    ).toBeNull();
    expect(
      planRefusal({ kind: "mqtt", url: "wss://192.168.1.20:9001" }, allowed),
    ).toBeNull();
  });

  it("does not touch a named server, whichever the deployment", () => {
    localNetworkFetchSeams.eligible = () => false;
    expect(
      planRefusal({ kind: "nats", url: "wss://nats.example.com" }, allowed),
    ).toBeNull();
  });

  it("still refuses plain ws away from loopback first", () => {
    localNetworkFetchSeams.eligible = () => true;
    expect(
      planRefusal({ kind: "nostr", url: "ws://relay.example.com" }, allowed),
    ).toBe("unsupported-scheme");
  });
});
