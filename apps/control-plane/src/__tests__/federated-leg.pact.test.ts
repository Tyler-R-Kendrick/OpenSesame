import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSecretFields, assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import {
  decodePending,
  encodePending,
  federatedRedirectUri,
  federatedUpstreams,
  isTrustedUpstream,
  matchUpstreamHint,
} from "../interactions/federated.js";

const here = dirname(fileURLToPath(import.meta.url));
const federatedSource = readFileSync(
  join(here, "../interactions/federated.ts"),
  "utf8",
);
const routesSource = readFileSync(
  join(here, "../routes/interactions.ts"),
  "utf8",
);

function config(overrides: Partial<ControlPlaneConfig> = {}) {
  return {
    publicUrl: "https://identity.example",
    allowDevDefaults: false,
    trustedUpstreamIssuers: ["https://shoo.dev"],
    ...overrides,
  } as ControlPlaneConfig;
}

/**
 * PACT — the federated relying-party leg (ADR 0052).
 *
 * These pin the *order* in which the leg makes its decisions, not just the
 * outcomes. Order is the security property here: an allowlist consulted after
 * a network call has already leaked the request, and a pending cookie deleted
 * after the exchange leaves a replayable code behind. A refactor that keeps
 * every assertion true but reorders the checks is exactly the change these
 * catch.
 */
describe("PACT — federated leg fail-closed ordering", () => {
  it("checks the issuer allowlist before it ever talks to the network", () => {
    assertSourceOrder(federatedSource, [
      "export async function beginFederatedAuth",
      "isTrustedUpstream(ctx.config, issuer)",
      "untrusted_issuer",
      "upstreamConfiguration(ctx, issuer)",
    ]);
  });

  it("re-checks the allowlist on the way back in, not only on the way out", () => {
    // The pending cookie names its own issuer. Trusting it because "we checked
    // at start" would let a stale cookie outlive a withdrawn trust decision.
    assertSourceOrder(federatedSource, [
      "export async function completeFederatedAuth",
      "isTrustedUpstream(ctx.config, pending.issuer)",
      "untrusted_issuer",
      "authorizationCodeGrant",
    ]);
  });

  it("requires an id_token and binds state, nonce and the PKCE verifier", () => {
    assertSourceOrder(federatedSource, [
      "authorizationCodeGrant",
      "pkceCodeVerifier: pending.verifier",
      "expectedState: pending.state",
      "expectedNonce: pending.nonce",
      "idTokenExpected: true",
    ]);
  });

  it("verifies the id_token against the issuer's JWKS after the grant", () => {
    // openid-client does not check the id_token signature for the code grant
    // (OIDC Core §3.1.3.7 permits leaning on TLS). federated-signin.md §7.5
    // promises a JWKS check, and an http:// dev broker has no TLS to lean on,
    // so the leg verifies explicitly. Reordering these — or dropping the
    // verify — reinstates a leg that accepts a token signed by any key.
    assertSourceOrder(federatedSource, [
      "authorizationCodeGrant",
      "tokens.id_token",
      "verifyOrgIdToken(rawIdToken, pending.issuer)",
      "verified.sub",
    ]);
  });

  it("refuses an exchange that returns no id_token at all", () => {
    assertSourceOrder(federatedSource, [
      "rawIdToken = tokens.id_token",
      "if (!rawIdToken)",
      "returned no id_token",
    ]);
  });

  it("deletes the single-use pending cookie before the exchange runs", () => {
    assertSourceOrder(routesSource, [
      "decodePending(getCookie",
      "deleteCookie(c, pendingCookieName(uid)",
      "completeFederatedAuth",
    ]);
  });

  it("verifies CSRF before doing any work on the start route", () => {
    assertSourceOrder(routesSource, [
      'routes.post("/:uid/federated/start"',
      "verifyCsrf(uid, fields)",
      "Invalid or expired CSRF token",
      "beginFederatedAuth",
    ]);
  });

  it("resolves an existing identity before minting anything new", () => {
    // Reversing these would mint a throwaway principal on every sign-in and
    // then collide with the identity already bound to the real one.
    assertSourceOrder(routesSource, [
      "externalIdentities.findByTuple",
      "mintProvisionalForInteraction",
      "attachVerifiedExternalIdentity",
    ]);
  });
});

describe("PACT — federated leg wire shape", () => {
  it("derives an origin-profile client id from the deployment origin", () => {
    expect(federatedRedirectUri(config(), "uid-1")).toBe(
      "https://identity.example/interaction/uid-1/federated/callback",
    );
  });

  it("keeps the callback under /interaction/:uid so the interaction resumes", () => {
    // oidc-provider's interaction cookie is path-scoped; a callback anywhere
    // else arrives without the interaction it is supposed to finish.
    expect(federatedRedirectUri(config(), "uid-1")).toContain(
      "/interaction/uid-1/",
    );
  });

  it("percent-encodes a uid rather than splicing it into the path", () => {
    expect(federatedRedirectUri(config(), "a/../b")).toBe(
      "https://identity.example/interaction/a%2F..%2Fb/federated/callback",
    );
  });

  it("tolerates a public URL with a trailing slash", () => {
    expect(
      federatedRedirectUri(
        config({ publicUrl: "https://identity.example/" }),
        "u",
      ),
    ).toBe("https://identity.example/interaction/u/federated/callback");
  });

  it("admits exactly the configured issuers and nothing adjacent", () => {
    const c = config({ trustedUpstreamIssuers: ["https://shoo.dev"] });
    expect(isTrustedUpstream(c, "https://shoo.dev")).toBe(true);
    for (const near of [
      "https://shoo.dev/",
      "https://shoo.dev.evil.test",
      "http://shoo.dev",
      "https://evil.test/https://shoo.dev",
      "",
    ]) {
      expect(isTrustedUpstream(c, near)).toBe(false);
    }
  });

  it("never resolves a hint to an issuer outside the allowlist", () => {
    const upstreams = federatedUpstreams(
      config({ trustedUpstreamIssuers: ["https://shoo.dev"] }),
    );
    for (const hint of ["mock", "http://127.0.0.1:9090", "evil.test"]) {
      expect(matchUpstreamHint(upstreams, hint)).toBeUndefined();
    }
  });
});

describe("PACT — pending leg state", () => {
  const pending = {
    issuer: "https://shoo.dev",
    state: "st",
    nonce: "no",
    verifier: "ve",
  };

  it("round-trips exactly the four fields and nothing else", () => {
    const decoded = decodePending(encodePending(pending));
    expect(decoded).toEqual(pending);
    expect(Object.keys(decoded ?? {}).sort()).toEqual([
      "issuer",
      "nonce",
      "state",
      "verifier",
    ]);
  });

  it("refuses any record missing a field, rather than defaulting one", () => {
    // A leg missing its nonce or verifier must not silently proceed with an
    // unbound exchange; the callback treats undefined as "start again".
    for (const partial of [
      { issuer: "i", state: "s", nonce: "n" },
      { issuer: "i", state: "s", verifier: "v" },
      { issuer: "i", nonce: "n", verifier: "v" },
      { state: "s", nonce: "n", verifier: "v" },
    ]) {
      const raw = Buffer.from(JSON.stringify(partial)).toString("base64url");
      expect(decodePending(raw)).toBeUndefined();
    }
  });

  it("carries no secret-shaped field names", () => {
    assertNoSecretFields(decodePending(encodePending(pending)) ?? {});
  });
});
