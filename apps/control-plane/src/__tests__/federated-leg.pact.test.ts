import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { overlapCast } from "@opensesame/os-domain";
import { assertNoSecretFields, assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import {
  decodePending,
  encodePending,
  federatedUpstreams,
  isTrustedUpstream,
  matchUpstreamHint,
  stableFederatedRedirectUri,
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
const callbackSource = readFileSync(
  join(here, "../routes/federated-callback.ts"),
  "utf8",
);

/**
 * A source oracle reads the file as written, which stops being true the moment
 * a mutation run instruments it: Stryker rewrites each expression through a
 * `stryMutAct_` guard, so literal fragments like `idTokenExpected: true` are no
 * longer present in order — or at all.
 *
 * These oracles are a refactor guard, not a behavioural claim, and mutation
 * testing measures behaviour. So under instrumentation they step aside rather
 * than assert against rewritten code. Everything else in this file is
 * behavioural and keeps running either way.
 *
 * Worth knowing before adding any file to the Stryker `mutate` set: a file that
 * is both mutated and covered by a source oracle will fail the dry run, which
 * is how this was found.
 */
const INSTRUMENTED = federatedSource.includes("stryMutAct_");
const describeSourceOracle = INSTRUMENTED ? describe.skip : describe;

function config(overrides: Partial<ControlPlaneConfig> = {}) {
  return overlapCast({
    publicUrl: "https://identity.example",
    allowDevDefaults: false,
    trustedUpstreamIssuers: ["https://shoo.dev"],
    ...overrides,
  });
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
describeSourceOracle("PACT — federated leg fail-closed ordering", () => {
  it("resolves trust before it ever talks to the network", () => {
    // `resolveTrustedIssuer` (C2) is the fence, and `resolveOrRefuse` is the
    // only caller: an issuer nothing vouches for must be refused before
    // discovery, or the mere attempt has already told an attacker's server
    // that this deployment will dereference an arbitrary URL.
    assertSourceOrder(federatedSource, [
      "export async function beginFederatedAuth",
      "resolveOrRefuse(ctx, issuer)",
      "clientModeFor(ctx.config, trust)",
      "upstreamConfiguration(ctx, issuer, mode)",
    ]);
  });

  it("re-resolves trust on the way back in, not only on the way out", () => {
    // The pending cookie names its own issuer. Trusting it because "we checked
    // at start" would let a stale cookie outlive a withdrawn trust decision —
    // a BYO record disabled by an operator, or an org that removed its issuer.
    assertSourceOrder(federatedSource, [
      "export async function completeFederatedAuth",
      "resolveOrRefuse(ctx, pending.issuer)",
      "clientModeFor(ctx.config, trust)",
      "authorizationCodeGrant",
    ]);
  });

  it("maps an unresolved issuer to untrusted_issuer and nothing softer", () => {
    assertSourceOrder(federatedSource, [
      "async function resolveOrRefuse",
      "resolveTrustedIssuer(ctx, issuer)",
      "if (!trust)",
      "untrusted_issuer",
    ]);
  });

  it("pins the Origin header to origin-profile mode alone (T10)", () => {
    // A confidential client is bound by its secret; one that also claimed a
    // browser origin is a mode violation, and a secret sent to a broker that
    // expects the origin-profile contract is a secret sent somewhere it was
    // never registered.
    assertSourceOrder(federatedSource, [
      "async function upstreamConfiguration",
      "mode.originProfile",
      "originPinnedFetch(siteOrigin(ctx.config))",
    ]);
  });

  it("keys the discovery cache by client id as well as issuer (T1)", () => {
    assertSourceOrder(federatedSource, [
      "function discoveryCacheKey",
      "${issuer}|${clientId}",
      "async function upstreamConfiguration",
      "discoveryCacheKey(issuer, mode.clientId)",
      "discoveryCache.get(key)",
    ]);
  });

  it("disposes of an upstream refresh token instead of storing one", () => {
    // D13: the identity plane takes no custody of somebody else's long-lived
    // credential. Revocation is best effort; dropping it is the guarantee.
    assertSourceOrder(federatedSource, [
      "rawIdToken = tokens.id_token",
      "disposeRefreshToken(ctx, config, mode, tokens.refresh_token)",
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
});

/**
 * The route file is not in the Stryker `mutate` set, so these oracles read it
 * as written and run under a mutation pass too.
 */
describe("PACT — federated route ordering", () => {
  it("deletes the single-use pending cookie before the exchange runs", () => {
    assertSourceOrder(routesSource, [
      "decodePending(getCookie",
      "deleteCookie(c, pendingCookieName(uid)",
      "completeFederatedLeg(ctx, pending",
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

  it("refuses an unknown provider id instead of falling back to the issuer", () => {
    assertSourceOrder(routesSource, [
      "requestedProvider(ctx, providerId, issuer)",
      "if (providerId && !descriptor)",
      "not trusted by this server",
      "beginOAuth2Auth",
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

  it("follows the attached identity's principal, not the mint (D15)", () => {
    // The verified-email policy may attach to a principal that already exists.
    // Binding the interaction to `minted.principalId` regardless would sign
    // the human in as an empty guest and strand their real account.
    assertSourceOrder(routesSource, [
      "attachVerifiedExternalIdentity",
      "accountId = attached.identity.principalId",
      "if (accountId === minted.principalId)",
      "ctx.config.provisionalCookieName",
    ]);
  });

  it("joins the organization only after the principal is resolved", () => {
    assertSourceOrder(routesSource, [
      "externalIdentities.findByTuple",
      "if (pending.orgId)",
      "jitJoinOrganization",
      "finishLoginInteraction",
    ]);
  });

  /**
   * The stable callback (ADR 0055) is one unauthenticated URL serving every
   * interaction. Its safety rests entirely on doing nothing: no exchange, no
   * admission, no session. A future edit that "helpfully" completed the
   * sign-in here would be completing it for a request that carries no
   * interaction cookie and no pending state, which is how a shared callback
   * becomes a way to finish somebody else's ceremony.
   */
  it("completes nothing at the stable callback", () => {
    for (const forbidden of [
      "authorizationCodeGrant",
      "completeFederatedAuth",
      "completeOAuth2Auth",
      "interactionResult",
      "attachVerifiedExternalIdentity",
      "mintProvisionalForInteraction",
      "setCookie",
      "getCookie",
    ]) {
      expect(callbackSource).not.toContain(forbidden);
    }
  });

  it("validates the interaction a state names before redirecting to it", () => {
    // The uid becomes a path this server sends a browser to. Anything that is
    // not the shape oidc-provider mints is refused, and a state that names no
    // interaction is refused rather than defaulted.
    assertSourceOrder(callbackSource, [
      "function interactionUidFromState",
      "state.indexOf(STATE_UID_SEPARATOR)",
      "if (separator <= 0) return undefined",
      "UID_PATTERN.test(uid)",
      "function handBack",
      "if (uid === undefined) return undefined",
      "for (const name of CALLBACK_PARAMS)",
      "MAX_CALLBACK_PARAM_LENGTH",
    ]);
  });

  it("re-materializes a form_post callback without completing anything", () => {
    // T4: the POST handler must do no completion work. It copies four
    // allowlisted parameters into a 303 and stops — the GET that follows is
    // the request that carries the SameSite=Lax cookies.
    assertSourceOrder(routesSource, [
      'routes.post("/:uid/federated/callback"',
      "for (const name of FORM_POST_CALLBACK_PARAMS)",
      "MAX_FORM_POST_PARAM_LENGTH",
      "return c.redirect(",
      'routes.get("/:uid/federated/callback"',
    ]);
  });
});

describe("PACT — federated leg wire shape", () => {
  it("redirects every leg to one deployment-wide callback", () => {
    expect(stableFederatedRedirectUri(config())).toBe(
      "https://identity.example/v1/federated/callback",
    );
  });

  it("names no interaction in the URI providers match byte for byte", () => {
    // A redirect URI is registered once — in a provider console, by a tenant
    // admin, or by RFC 7591 — and matched exactly afterwards. One naming the
    // interaction it was registered from would admit exactly one sign-in.
    expect(stableFederatedRedirectUri(config())).not.toContain("/interaction/");
  });

  it("does not vary with anything a caller controls", () => {
    // The only input is the deployment's own public URL. Two derivations that
    // could disagree are how a token request ends up quoting a redirect_uri
    // the authorization request never used.
    expect(stableFederatedRedirectUri(config())).toBe(
      stableFederatedRedirectUri(config()),
    );
  });

  it("tolerates a public URL with a trailing slash", () => {
    expect(
      stableFederatedRedirectUri(
        config({ publicUrl: "https://identity.example/" }),
      ),
    ).toBe("https://identity.example/v1/federated/callback");
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

  it("round-trips exactly the four v1 fields and invents no others", () => {
    const decoded = decodePending(encodePending(pending));
    expect(decoded).toEqual(pending);
    expect(Object.keys(decoded ?? {}).sort()).toEqual([
      "issuer",
      "nonce",
      "state",
      "verifier",
    ]);
  });

  it("accepts a v1 cookie unchanged, with no defaulted kind (T12)", () => {
    // A cookie written by the previous release is in somebody's browser while
    // the new one boots. It must still decode, and `kind` must stay absent
    // rather than become a present `undefined` that re-encodes as null.
    const decoded = decodePending(encodePending(pending));
    expect(decoded && "kind" in decoded).toBe(false);
    expect(decodePending(encodePending(decoded ?? pending))).toEqual(pending);
  });

  it("carries the v2 provenance a leg started from, and only that", () => {
    const v2 = { ...pending, kind: "oidc" as const, orgId: "org_1" };
    const decoded = decodePending(encodePending(v2));
    expect(decoded).toEqual(v2);
    expect(decoded && "byoId" in decoded).toBe(false);
    expect(decoded && "providerId" in decoded).toBe(false);
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
