import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import type { AppContext } from "../context.js";
import {
  FederatedAuthError,
  beginFederatedAuth,
  completeFederatedAuth,
  federatedUpstreams,
} from "../interactions/federated.js";

/**
 * Atomic units for the federated leg's guards.
 *
 * The route and chaos suites drive whole journeys; these call the guards
 * directly, because two of them are reachable only in situations a journey
 * cannot easily produce — and one had never been executed at all despite a
 * PACT test asserting its position in the source. A guard whose ordering is
 * pinned but whose body never runs is a guard nobody has checked.
 */

function ctxWith(overrides: Partial<ControlPlaneConfig> = {}): AppContext {
  return overlapCast({
    config: {
      publicUrl: "https://identity.example",
      allowDevDefaults: false,
      trustedUpstreamIssuers: ["https://shoo.dev"],
      ...overrides,
    },
  });
}

const PENDING = {
  issuer: "https://shoo.dev",
  state: "st",
  nonce: "no",
  verifier: "ve",
};

describe("the allowlist is re-checked on the way back in", () => {
  /**
   * The pending cookie names its own issuer. Trusting it because "we checked
   * at start" would let a cookie minted before an issuer was removed from
   * OPENSESAME_TRUSTED_UPSTREAMS still complete a sign-in afterwards. The
   * check must run before any network call, so this rejects without one.
   */
  it("refuses a callback whose pending issuer is no longer trusted", async () => {
    await expect(
      completeFederatedAuth(
        ctxWith({ trustedUpstreamIssuers: ["https://shoo.dev"] }),
        { ...PENDING, issuer: "https://evil.example" },
        new URL("https://identity.example/cb?code=c&state=st"),
      ),
    ).rejects.toThrow(/not trusted/);
  });

  it("carries the untrusted_issuer code, not a generic failure", async () => {
    const failure = await completeFederatedAuth(
      ctxWith(),
      { ...PENDING, issuer: "https://evil.example" },
      new URL("https://identity.example/cb?code=c&state=st"),
    ).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(FederatedAuthError);
    expect((failure as FederatedAuthError).code).toBe("untrusted_issuer");
  });

  it("refuses to start against an issuer outside the allowlist", async () => {
    const failure = await beginFederatedAuth(
      ctxWith(),
      "uid-1",
      "https://evil.example",
    ).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(FederatedAuthError);
    expect((failure as FederatedAuthError).code).toBe("untrusted_issuer");
  });

  it("refuses an empty issuer rather than treating it as unset", async () => {
    const failure = await beginFederatedAuth(ctxWith(), "uid-1", "").catch(
      (caught: unknown) => caught,
    );
    expect((failure as FederatedAuthError).code).toBe("untrusted_issuer");
  });
});

describe("describing an issuer that is not a URL", () => {
  /**
   * `trustedUpstreamIssuers` is operator-supplied config. A typo must degrade
   * to showing the raw string on the login page, not throw while rendering it
   * — a broken entry should cost one unusable button, not the whole page.
   */
  it("falls back to the raw string instead of throwing", () => {
    const upstreams = federatedUpstreams(
      overlapCast({ trustedUpstreamIssuers: ["not-a-url"] }),
    );
    expect(upstreams).toEqual([
      { id: "not-a-url", issuer: "not-a-url", label: "not-a-url" },
    ]);
  });

  it("keeps describing the valid entries either side of a broken one", () => {
    const upstreams = federatedUpstreams(
      overlapCast({
        trustedUpstreamIssuers: [
          "https://shoo.dev",
          ":::",
          "http://127.0.0.1:9090",
        ],
      }),
    );
    // Allowlist order is preserved, which is also the order the buttons
    // render in — a broken entry must not reshuffle the working ones.
    expect(upstreams.map((u) => u.id)).toEqual(["shoo", ":::", "mock"]);
    expect(upstreams.find((u) => u.id === "shoo")?.label).toBe("Google");
  });
});
