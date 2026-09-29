/**
 * The allowed-origin grammar: exactly `URL.origin`, https unless loopback.
 * Carried from #470, which refused a malformed origin at parse instead of
 * letting it silently deny every request egress compared against it.
 */
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { parseInstancePolicy } from "./documents.js";
import { FIXTURE_POLICIES } from "./fixtures.js";
import { isServiceOrigin } from "./origins.js";

function policyWith(origins: readonly string[]): JsonObject {
  const parsed: JsonValue = JSON.parse(
    JSON.stringify({
      ...FIXTURE_POLICIES.family,
      network: { externalServices: "allow", allowedServiceOrigins: origins },
    }),
  );
  if (!isJsonObject(parsed)) throw new Error("fixture is not an object");
  return parsed;
}

describe("isServiceOrigin", () => {
  it.each([
    "https://api.example.com",
    "https://api.example.com:8443",
    "https://xn--bcher-kva.example",
    "http://localhost:8787",
    "http://127.0.0.1:8788",
    "http://[::1]:9090",
    "http://api.localhost:8787",
    "wss://relay.example.com",
    "wss://mqtt.example.com:8884",
    "ws://localhost:7777",
    "ws://127.0.0.1:4222",
    "ws://[::1]:4222",
  ])("accepts %s", (origin) => {
    expect(isServiceOrigin(origin)).toBe(true);
  });

  it.each([
    ["https://api.example.com/", "a trailing slash is a URL, not an origin"],
    ["https://api.example.com/v1", "a path"],
    ["https://API.example.com", "not what URL.origin prints"],
    ["https://api.example.com:443", "the default port is not printed"],
    ["https://user@api.example.com", "credentials"],
    ["api.example.com", "no scheme"],
    ["http://api.example.com", "plain http off loopback"],
    ["http://192.168.1.10", "plain http to the local network"],
    ["ws://relay.example.com", "plain ws off loopback"],
    ["ws://192.168.1.10:7777", "plain ws to the local network"],
    ["wss://relay.example.com/", "a trailing slash on a wss origin"],
    ["wss://relay.example.com/nostr", "a path on a wss origin"],
    ["wss://user:pw@relay.example.com", "credentials on a wss origin"],
    ["wss://relay.example.com:443", "the default wss port is not printed"],
    ["wss://*.example.com", "a wildcard host"],
    ["https://*.example.com", "a wildcard host is not one host"],
    ["wss:", "a bare scheme"],
    ["ftp://files.example.com", "another scheme"],
    ["https://bücher.example", "an unencoded host"],
    ["null", "an opaque origin"],
    ["", "nothing"],
  ])("refuses %s (%s)", (origin) => {
    expect(isServiceOrigin(origin)).toBe(false);
  });
});

describe("a policy's allowedServiceOrigins", () => {
  it("parses when every entry is an origin", () => {
    const result = parseInstancePolicy(
      policyWith(["https://api.example.com", "http://localhost:8787"]),
    );
    expect(result.ok).toBe(true);
  });

  it("is refused, naming each malformed entry", () => {
    const result = parseInstancePolicy(
      policyWith([
        "https://api.example.com",
        "https://api.example.com/",
        "http://api.example.com",
      ]),
    );
    expect(result.ok).toBe(false);
    const paths = result.ok ? [] : result.diagnostics.map((d) => d.path);
    expect(paths).toEqual([
      "network.allowedServiceOrigins[1]",
      "network.allowedServiceOrigins[2]",
    ]);
  });
});
