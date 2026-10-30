import { describe, expect, it } from "vitest";
import {
  boatCheckoutUrl,
  boatClaimUrl,
  boatHostedRelay,
  boatOrigin,
} from "./boat-endpoints.js";

describe("Boat endpoint trust", () => {
  it("requires HTTPS for remote control planes and refuses credentials or paths", () => {
    expect(boatOrigin("https://boat.dev/")).toBe("https://boat.dev");
    expect(boatOrigin("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234");
    for (const value of [
      "http://boat.dev",
      "http://localhost:1",
      "http://127.1:1",
      "http://0x7f000001:1",
      "http://0177.0.0.1:1",
      "https://user:pass@boat.dev",
      "https://boat.dev/path",
      "https://boat.dev/?x=1",
    ]) {
      expect(() => boatOrigin(value)).toThrow();
    }
  });
  it("binds claim links to the control plane and checkout to Stripe", () => {
    expect(
      boatClaimUrl(
        "/api/boat/agent/identity/claim?claim_attempt_token=x",
        "https://boat.dev",
      ),
    ).toBe(
      "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=x",
    );
    expect(() =>
      boatClaimUrl(
        "https://evil.test/api/boat/agent/identity/claim",
        "https://boat.dev",
      ),
    ).toThrow();
    expect(() =>
      boatClaimUrl("https://boat.dev/other", "https://boat.dev"),
    ).toThrow();
    expect(
      boatCheckoutUrl(
        "https://checkout.stripe.com/c/pay/example",
        "https://boat.dev",
      ),
    ).toContain("checkout.stripe.com");
    for (const value of [
      "http://checkout.stripe.com/",
      "https://checkout.stripe.com.evil.test/",
      "https://evil.test/",
    ])
      expect(() => boatCheckoutUrl(value, "https://boat.dev")).toThrow();
  });
  it("binds the protected WSS route to the same authenticated sandbox and port", () => {
    expect(
      boatHostedRelay(
        "https://swift-otter-8787.on.boat.dev/?_token=secret",
        "https://swift-otter.on.boat.dev",
        "https://boat.dev",
        8787,
      ),
    ).toEqual({
      url: "wss://swift-otter-8787.on.boat.dev/",
      cookie: "_port_auth=secret",
    });
    for (const value of [
      "http://swift-otter-8787.on.boat.dev/?_token=secret",
      "https://other-8787.on.boat.dev/?_token=secret",
      "https://swift-otter-1234.on.boat.dev/?_token=secret",
      "https://swift-otter-8787.on.boat.dev.evil.test/?_token=secret",
      "https://swift-otter-8787.on.boat.dev/?_token=one&_token=two",
      "https://swift-otter-8787.on.boat.dev/?_token=secret%3Bother%3Dvalue",
      "https://swift-otter-8787.on.boat.dev/?_token=secret&next=x",
      "https://swift-otter-8787.on.boat.dev/",
    ])
      expect(() =>
        boatHostedRelay(
          value,
          "https://swift-otter.on.boat.dev",
          "https://boat.dev",
          8787,
        ),
      ).toThrow();
    expect(
      boatHostedRelay(
        "http://127.0.0.1:8787",
        "http://127.0.0.1:12345",
        "http://127.0.0.1:12345",
        8787,
      ),
    ).toEqual({ url: "ws://127.0.0.1:8787/" });
    expect(() =>
      boatHostedRelay(
        "http://127.0.0.1:9999",
        "http://127.0.0.1:12345",
        "http://127.0.0.1:12345",
        8787,
      ),
    ).toThrow();
    expect(() =>
      boatHostedRelay(
        "http://127.0.0.1:8787",
        "http://127.0.0.1:9999",
        "http://127.0.0.1:12345",
        8787,
      ),
    ).toThrow();
    expect(() =>
      boatHostedRelay(
        "http://127.0.0.1:1234",
        "http://127.0.0.1",
        "https://boat.dev",
        8787,
      ),
    ).toThrow();
  });
});

it.each([307, 308])(
  "does not follow credential-bearing %s control-plane redirects",
  async (status) => {
    const { createServer } = await import("node:http");
    const { BoatAgentAuth } = await import("./boat-auth.js");
    const { BoatClient } = await import("./boat-client.js");
    let redirected = 0;
    const server = createServer((request, response) => {
      if (request.url === "/sink") {
        redirected += 1;
        response.writeHead(200).end("{}");
        return;
      }
      response.writeHead(status, { location: "/sink" }).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!(address instanceof Object)) throw new Error("missing address");
      const origin = `http://127.0.0.1:${address.port}`;
      await expect(
        new BoatAgentAuth({ origin }).requestClaim(
          "claim-secret",
          "person@example.test",
        ),
      ).rejects.toThrow();
      await expect(
        new BoatAgentAuth({ origin }).exchangeAssertion("assertion-secret"),
      ).rejects.toThrow();
      await expect(
        new BoatClient({ origin }).createCheckout("access-secret"),
      ).rejects.toThrow();
      await expect(
        new BoatClient({ origin }).getSandbox("access-secret", "bx_23456789"),
      ).rejects.toThrow();
      expect(redirected).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
