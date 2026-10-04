import { describe, expect, it } from "vitest";

import { normalizePushEndpoint } from "../push-endpoint.js";

describe("normalizePushEndpoint", () => {
  const CANONICAL = "https://push.example.test/wpush/v2/AbC-1?x=1";

  it.each([
    "https://push.example.test/wpush/v2/AbC-1?x=1",
    "HTTPS://Push.Example.TEST/wpush/v2/AbC-1?x=1",
    "https://push.example.test:443/wpush/v2/AbC-1?x=1",
    "https://push.example.test./wpush/v2/AbC-1?x=1",
    "https://push.example.test/wpush/v2/AbC-1?x=1#fragment",
    "https://push.example.test/wpush/./v2/../v2/AbC-1?x=1",
    "https://push.example.test/wpush/v2/%41bC%2D1?x=1",
  ])("gives %s the one canonical spelling", (variant) => {
    expect(normalizePushEndpoint(variant)).toBe(CANONICAL);
  });

  it("spells percent escapes one way and leaves the rest of the path alone", () => {
    expect(normalizePushEndpoint("https://p.example.test/a%2fb%7e")).toBe(
      "https://p.example.test/a%2Fb~",
    );
    // Path case is significant to a server, so it is never folded.
    expect(normalizePushEndpoint("https://p.example.test/AbC")).not.toBe(
      normalizePushEndpoint("https://p.example.test/abc"),
    );
    // Distinct ports and query strings are distinct destinations.
    expect(normalizePushEndpoint("https://p.example.test:8443/x")).toContain(
      ":8443",
    );
    expect(normalizePushEndpoint("https://p.example.test/x?a=1")).not.toBe(
      normalizePushEndpoint("https://p.example.test/x?a=2"),
    );
  });

  it("is idempotent, and says so when it is not a URL", () => {
    const once = normalizePushEndpoint("HTTPS://Push.Example.TEST:443/X%7e#f");
    expect(once).toBeDefined();
    expect(normalizePushEndpoint(once ?? "")).toBe(once);
    expect(normalizePushEndpoint("not a url")).toBeUndefined();
    expect(normalizePushEndpoint("")).toBeUndefined();
  });
});
