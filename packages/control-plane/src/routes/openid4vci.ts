/**
 * The OpenID4VCI issuer, mounted.
 *
 * `@opensesame/openid4vci` is a pure library — it mints offers, verifies key
 * proofs and signs SD-JWT VCs, but it opens no socket and holds no state. This
 * module is the HTTP surface around it: the six endpoints a wallet touches,
 * each thin, each delegating every security decision back to the package.
 *
 * The whole ceremony:
 *
 *   POST /oid4vci/offers          (authenticated) mint an offer for a caller
 *   GET  /oid4vci/offers/:id      the offer resource — F10-protected fetch
 *   POST /oid4vci/nonce           a fresh c_nonce
 *   POST /oid4vci/token           spend the pre-authorized code → access token
 *   POST /oid4vci/credential      verify the key proof → sign the credential
 *   GET  /.well-known/openid-credential-issuer   what we support
 *
 * **F10 lives here.** The library refuses to mint an offer that has neither a
 * Transaction Code nor a `protectedRedemption` promise; this module *keeps*
 * that promise. A protected offer is minted bound to the authenticated caller,
 * its resource is returned only to that principal, and the token endpoint
 * refuses to spend its code for anyone else. The pre-authorized code fetched
 * off a screen by a bystander redeems nothing.
 *
 * **Grants are durable, never process-local.** Every store this module uses is
 * a `DurableMap` in a deployment with a database — see `repos/openid4vci-
 * stores.ts` — so an offer minted on one replica is redeemable on another and
 * survives a restart, and a code, nonce or access token is spent exactly once
 * across the fleet.
 *
 * Signing key material, the pepper, the issuer identifier and the stores all
 * arrive as an injected {@link Openid4vciIssuerRuntime}: the wiring is the
 * mounting swarm's, and a test drives the same routes with a generated key.
 */

import { randomBytes } from "node:crypto";
import {
  type CredentialDisplay,
  type IssueCredentialInput,
  type IssuerMetadataConfig,
  type NonceStore,
  Openid4vciError,
  PRE_AUTHORIZED_CODE_GRANT_TYPE,
  SD_JWT_VC_MEDIA_TYPE,
  type SupportedAlgorithm,
  buildIssuerMetadata,
  createCredentialOffer,
  deriveSubjectRef,
  issueCredential,
  verifyProofOfPossession,
} from "@opensesame/openid4vci";
import {
  type Clock,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { type Context, Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import type {
  AccessTokenRecord,
  DurableAccessTokenStore,
  DurableOfferStore,
  DurablePreAuthorizedCodeStore,
} from "../repos/openid4vci-stores.js";

/** The seam the mounting swarm wires; a test fills it with a generated key. */
export interface Openid4vciIssuerRuntime {
  /** Credential Issuer Identifier — https, no trailing slash. */
  readonly issuer: string;
  /** The `vct` written into every credential of the one configuration. */
  readonly vct: string;
  /** The key under `credential_configurations_supported`. */
  readonly credentialConfigurationId: string;
  readonly signing: {
    readonly key: CryptoKey | Uint8Array;
    readonly algorithm: SupportedAlgorithm;
    /** Names the issuer key in a published JWKS, for rotation. */
    readonly keyId?: string;
  };
  /** Secret pepper for pairwise subject references. Never leaves the host. */
  readonly subjectPepper: Uint8Array | string;
  readonly credentialLifetimeSeconds: number;
  readonly offerTtlSeconds: number;
  readonly nonceTtlSeconds: number;
  readonly accessTokenTtlSeconds: number;
  readonly grants: DurablePreAuthorizedCodeStore;
  readonly nonces: NonceStore;
  readonly offers: DurableOfferStore;
  readonly accessTokens: DurableAccessTokenStore;
  readonly clock: Clock;
  readonly display?: readonly CredentialDisplay[];
}

/** An unguessable, public offer id. Not a secret — the link carries it. */
function newOfferId(): string {
  return randomBytes(16).toString("base64url");
}

// Writable views of otherwise-readonly inputs, so an optional field is set
// only when present rather than spread from an empty object — the repo runs
// exactOptionalPropertyTypes, and anti-slop forbids the `...(x ? {} : {…})`
// idiom that hides the omission.
type MutableIssuerMetadataConfig = {
  -readonly [K in keyof IssuerMetadataConfig]: IssuerMetadataConfig[K];
};
type MutableIssueCredentialInput = {
  -readonly [K in keyof IssueCredentialInput]: IssueCredentialInput[K];
};
type MutableAccessTokenRecord = {
  -readonly [K in keyof AccessTokenRecord]: AccessTokenRecord[K];
};

/**
 * Turn a library refusal into a `{ error }` body, or re-throw.
 *
 * Every `Openid4vciError` carries a `wireError` from the closed OpenID4VCI
 * vocabulary and nothing request-derived, so it is safe to return verbatim.
 * Anything else is re-thrown for `app.onError` to swallow into a 500 with a
 * correlation id — a foreign error must never reach a wallet with its message.
 * The caller narrows the caught binding to this type before calling.
 */
function wireErrorBody(error: Openid4vciError) {
  return { error: error.wireError };
}

/** Read a JSON or form body into a flat record of strings. */
async function readBody(
  c: Context<{ Variables: Variables }>,
): Promise<JsonObject> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    // `c.req.json()` is typed `any`; route it through the boundary type a
    // guard reads. `isJsonObject` then either accepts it or hands back `{}`.
    const parsed = overlapCast(await c.req.json().catch(() => undefined));
    return isJsonObject(parsed) ? parsed : {};
  }
  const form = await c.req.parseBody().catch(() => ({}));
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(form)) {
    const boundary = overlapCast(value);
    if (isString(boundary)) out[key] = boundary;
  }
  return out;
}

/**
 * Serialize a `JsonObject` payload by hand.
 *
 * `c.json` infers its response type from the argument, and the recursive
 * `JsonObject` shape sends that inference "excessively deep". These two
 * payloads — the issuer metadata and the stored offer — are already-built JSON
 * objects, so they are written straight to the body with the right type.
 */
function jsonObjectResponse(
  c: Context<{ Variables: Variables }>,
  value: JsonObject,
): Response {
  c.header("content-type", "application/json");
  return c.body(JSON.stringify(value));
}

/** The bearer token on the credential request — our own, not a session. */
function bearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (!header.toLowerCase().startsWith("bearer ")) return undefined;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : undefined;
}

export function createOpenid4vciRoutes(
  runtime: Openid4vciIssuerRuntime,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  const base = runtime.issuer;

  // ---- what we support ---------------------------------------------------
  app.get("/.well-known/openid-credential-issuer", (c) => {
    const config: MutableIssuerMetadataConfig = {
      credentialIssuer: base,
      credentialEndpoint: `${base}/oid4vci/credential`,
      nonceEndpoint: `${base}/oid4vci/nonce`,
      credentialConfigurationId: runtime.credentialConfigurationId,
      vct: runtime.vct,
      credentialSigningAlgorithm: runtime.signing.algorithm,
      proofSigningAlgorithms: [runtime.signing.algorithm],
    };
    if (runtime.display !== undefined) config.display = runtime.display;
    return jsonObjectResponse(c, buildIssuerMetadata(config));
  });

  // ---- mint an offer for the signed-in caller ----------------------------
  // Authenticated: an offer is minted *for* someone, and that principal is the
  // credential's subject. A `transactionCode` in the body switches from the
  // session-bound road (default) to an out-of-band second factor.
  app.post("/oid4vci/offers", requirePrincipal(), async (c) => {
    const principalId = c.get("principalId");
    if (principalId === undefined)
      return c.json({ error: "unauthorized" }, 401);
    const body = await readBody(c);
    const transactionCode = isString(body.transactionCode)
      ? body.transactionCode
      : undefined;

    const id = newOfferId();
    const offerUri = `${base}/oid4vci/offers/${id}`;
    try {
      const created = createCredentialOffer({
        credentialIssuer: base,
        credentialConfigurationIds: [runtime.credentialConfigurationId],
        offerUri,
        ttlSeconds: runtime.offerTtlSeconds,
        now: runtime.clock(),
        ...(transactionCode === undefined
          ? { protectedRedemption: true }
          : { txCode: { inputMode: "numeric" }, txCodeValue: transactionCode }),
      });
      // The subject principal rides beside the grant, never inside it. A
      // session-bound offer additionally gates redemption on this principal.
      await runtime.grants.register(created.grant, principalId);
      await runtime.offers.put(id, {
        offer: created.offer,
        requiresProtectedRedemption: created.grant.requiresProtectedRedemption,
        boundPrincipalId: principalId,
        expiresAt: created.grant.expiresAt,
      });
      return c.json({ offerLink: created.offerLink, offerUri });
    } catch (error) {
      if (error instanceof Openid4vciError) {
        return c.json(wireErrorBody(error), 400);
      }
      throw error;
    }
  });

  // ---- the offer resource: F10-protected ---------------------------------
  app.get("/oid4vci/offers/:id", async (c) => {
    const stored = await runtime.offers.get(c.req.param("id"));
    const now = runtime.clock();
    if (stored === undefined || stored.expiresAt.getTime() <= now.getTime()) {
      return c.json({ error: "not_found" }, 404);
    }
    if (stored.requiresProtectedRedemption) {
      // Answered only to the principal the offer was minted for. A bystander
      // who photographed the link gets the same 404 as a wrong id — no oracle.
      const principalId = c.get("principalId");
      if (
        principalId === undefined ||
        principalId !== stored.boundPrincipalId
      ) {
        return c.json({ error: "not_found" }, 404);
      }
    }
    return jsonObjectResponse(c, stored.offer);
  });

  // ---- a fresh challenge -------------------------------------------------
  app.post("/oid4vci/nonce", async (c) => {
    const issued = await runtime.nonces.issue(runtime.clock());
    const expiresIn = Math.max(
      0,
      Math.floor(
        (issued.expiresAt.getTime() - runtime.clock().getTime()) / 1000,
      ),
    );
    c.header("cache-control", "no-store");
    return c.json({ c_nonce: issued.nonce, c_nonce_expires_in: expiresIn });
  });

  // ---- spend the pre-authorized code → access token ----------------------
  app.post("/oid4vci/token", async (c) => {
    const body = await readBody(c);
    if (body.grant_type !== PRE_AUTHORIZED_CODE_GRANT_TYPE) {
      return c.json({ error: "unsupported_grant_type" }, 400);
    }
    const code = body["pre-authorized_code"];
    if (!isString(code)) return c.json({ error: "invalid_request" }, 400);
    const txCode = isString(body.tx_code) ? body.tx_code : undefined;
    try {
      const { redeemed, boundPrincipalId } = await runtime.grants.redeem(
        code,
        txCode,
        runtime.clock(),
      );
      // F10: a session-bound grant's code is not enough on its own. The caller
      // must be the principal it was minted for. Refused as `invalid_grant` —
      // the same answer a wrong code gets, so redemption is not an oracle.
      if (redeemed.requiresProtectedRedemption) {
        const principalId = c.get("principalId");
        if (principalId === undefined || principalId !== boundPrincipalId) {
          return c.json({ error: "invalid_grant" }, 400);
        }
      }
      const record: MutableAccessTokenRecord = {
        credentialConfigurationIds: redeemed.credentialConfigurationIds,
        expiresAt: new Date(
          runtime.clock().getTime() + runtime.accessTokenTtlSeconds * 1000,
        ),
      };
      if (boundPrincipalId !== undefined)
        record.boundPrincipalId = boundPrincipalId;
      const accessToken = await runtime.accessTokens.mint(record);
      c.header("cache-control", "no-store");
      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: runtime.accessTokenTtlSeconds,
      });
    } catch (error) {
      if (error instanceof Openid4vciError) {
        return c.json(wireErrorBody(error), 400);
      }
      throw error;
    }
  });

  // ---- verify the key proof → sign the credential ------------------------
  app.post("/oid4vci/credential", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (token === undefined) return c.json({ error: "invalid_token" }, 401);
    const record = await runtime.accessTokens.redeem(token, runtime.clock());
    if (record === undefined) return c.json({ error: "invalid_token" }, 401);
    if (record.boundPrincipalId === undefined) {
      // Every offer this module mints binds a subject principal; a token with
      // none is a record we never wrote. Refuse rather than issue a subjectless
      // credential.
      return c.json({ error: "credential_request_denied" }, 400);
    }

    const body = await readBody(c);
    const proof = readProofJwt(body);
    if (proof === undefined) {
      return c.json({ error: "invalid_credential_request" }, 400);
    }

    try {
      const verified = await verifyProofOfPossession(proof, {
        credentialIssuer: base,
        nonceStore: runtime.nonces,
        allowedAlgorithms: [runtime.signing.algorithm],
        now: runtime.clock(),
      });
      const subject = deriveSubjectRef({
        id: record.boundPrincipalId,
        audience: base,
        pepper: runtime.subjectPepper,
      });
      const issueInput: MutableIssueCredentialInput = {
        credentialIssuer: base,
        vct: runtime.vct,
        subject,
        holderJwk: verified.holderJwk,
        signingKey: runtime.signing.key,
        signingAlgorithm: runtime.signing.algorithm,
        lifetimeSeconds: runtime.credentialLifetimeSeconds,
        now: runtime.clock(),
      };
      if (runtime.signing.keyId !== undefined) {
        issueInput.signingKeyId = runtime.signing.keyId;
      }
      const issued = await issueCredential(issueInput);
      c.header("cache-control", "no-store");
      return c.json({
        credential: issued.credential,
        format: SD_JWT_VC_MEDIA_TYPE,
      });
    } catch (error) {
      if (error instanceof Openid4vciError) {
        return c.json(wireErrorBody(error), 400);
      }
      throw error;
    }
  });

  return app;
}

/** Pull the `jwt` out of an OpenID4VCI credential-request `proof` object. */
function readProofJwt(body: JsonObject): string | undefined {
  const proof = body.proof;
  if (!isJsonObject(proof)) return undefined;
  if (proof.proof_type !== "jwt") return undefined;
  return isString(proof.jwt) ? proof.jwt : undefined;
}
