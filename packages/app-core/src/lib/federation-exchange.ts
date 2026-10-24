/** Loaded only for a consumed, scrubbed callback owned by the initiating session and configuration. */
import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { assertSafeReturnTo } from "./federation-callback.js";
import { verifyConfiguredIdentityToken } from "./federation-configured-token.js";
import type {
  CompletedSignIn,
  TrustedUpstream,
} from "./federation-contract.js";
import { resolvePinnedEndpoints } from "./federation-endpoint-pin.js";
import { FederationError } from "./federation-error.js";
import type { UpstreamIdentity } from "./federation-native-session.js";
import type { PendingAuth } from "./federation-pending.js";

export type FederationExchangeContext = Readonly<{
  pending: Readonly<PendingAuth>;
  body: string;
  origin: string;
  clientId: string;
  upstreams: readonly TrustedUpstream[];
  assertCurrent: () => void;
  decodeClaims: (token: string) => JsonObject;
  issuerTrusted: (issuer: string) => boolean;
  issuerBrokered: (issuer: string) => boolean;
  subjectIsPairwise: (issuer: string) => boolean;
  save: (identity: UpstreamIdentity) => void;
}>;

async function requireActiveUpstreamSession(
  idToken: string,
  endpoint: string | undefined,
  issuer: string,
  context: FederationExchangeContext,
): Promise<void> {
  if (!endpoint) return;
  let response: Response;
  context.assertCurrent();
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${idToken}` },
      credentials: "omit",
    });
  } catch {
    return;
  }
  context.assertCurrent();
  if (response.status !== 401) return;
  let reason = "revoked";
  try {
    const body: { reason?: BoundaryValue } = overlapCast(await response.json());
    // The reason lands in on-screen copy: admit only a short token-shaped
    // word, never an arbitrary string a broker response happens to carry.
    if (isString(body.reason) && /^[a-z][a-z0-9_-]{0,63}$/i.test(body.reason)) {
      reason = body.reason;
    }
  } catch {
    /* the status alone is the answer */
  }
  context.assertCurrent();
  throw new FederationError(
    "login_required",
    reason === "expired"
      ? "That sign-in expired before it could finish. Try again."
      : `${issuer} says this sign-in is not authorized (${reason}). Sign in again.`,
  );
}

function pairwiseSubject(
  claims: JsonObject,
  pending: PendingAuth,
  issuer: string,
  context: FederationExchangeContext,
): string {
  // `sub` stands in for `pairwise_sub` on the legs whose subject is not a
  // shared broker's:
  //
  //  - an org round-trip, and the brokered issuer — the Identity API mints
  //    origin-profile subjects pairwise by construction (ADR 0050);
  //  - the operator's own provider (ADR 0078). `pairwise_sub` exists because a
  //    broker serving many unrelated relying parties would otherwise hand them
  //    all the same subject to correlate on. An Okta org or an Entra directory
  //    the operator configured is not that: they are the relying party. They
  //    also do not mint a claim of that name — it is our brokers' contract, not
  //    OIDC's — so demanding it would refuse every real provider. Correlation
  //    downstream is unaffected: an origin this app brokers *to* still gets the
  //    per-origin subject `derivedSubjectFor` computes, whatever the source.
  //
  // Every other broker must say `pairwise_sub` and mean it.
  const subjectIsPairwise =
    Boolean(pending.orgSlug) || context.subjectIsPairwise(issuer);
  const pairwiseSub = isString(claims.pairwise_sub)
    ? claims.pairwise_sub
    : subjectIsPairwise && isString(claims.sub)
      ? claims.sub
      : "";
  if (!pairwiseSub) {
    throw new FederationError(
      "invalid_token",
      subjectIsPairwise
        ? "Token carries no subject, so it identifies nobody."
        : "Token carries no pairwise_sub, so it identifies nobody.",
    );
  }
  return pairwiseSub;
}

function readIdentity(
  idToken: string,
  pending: PendingAuth,
  jwksUri: string,
  context: FederationExchangeContext,
): UpstreamIdentity {
  const claims = context.decodeClaims(idToken);
  const issuer = isString(claims.iss) ? claims.iss : "";
  if (issuer.replace(/\/+$/, "") !== pending.issuer.replace(/\/+$/, "")) {
    throw new FederationError(
      "issuer_mismatch",
      `Token was issued by ${issuer || "nobody"}, not ${pending.issuer}.`,
    );
  }
  if (!pending.orgSlug && !context.issuerTrusted(issuer)) {
    throw new FederationError(
      "untrusted_issuer",
      `${issuer} is not a trusted broker.`,
    );
  }

  const expected = context.clientId;
  const audience = Array.isArray(claims.aud)
    ? claims.aud.filter((value): value is string => isString(value))
    : [String(claims.aud ?? "")];
  if (!audience.includes(expected)) {
    throw new FederationError(
      "audience_mismatch",
      `Token was minted for ${audience.join(", ") || "nobody"}, not ${expected}.`,
    );
  }

  const exp = isNumber(claims.exp) ? claims.exp : 0;
  if (exp * 1000 <= Date.now()) {
    throw new FederationError("expired", "Token was already expired.");
  }

  const pairwiseSub = pairwiseSubject(claims, pending, issuer, context);

  return {
    issuer,
    upstreamId: pending.upstreamId,
    idToken,
    pairwiseSub,
    audience: expected,
    jwksUri,
    expiresAt: exp * 1000,
    email: isString(claims.email) ? claims.email : undefined,
    name: isString(claims.name) ? claims.name : undefined,
    picture: isString(claims.picture) ? claims.picture : undefined,
  };
}

export async function exchangeCapturedSignIn(
  context: FederationExchangeContext,
): Promise<CompletedSignIn> {
  const { pending } = context;
  const pinned = resolvePinnedEndpoints(pending, context.upstreams);
  const tokenEndpoint = pinned.tokenEndpoint;
  let response: Response;
  context.assertCurrent();
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: context.body,
      credentials: "omit",
    });
  } catch {
    // Browser-side exchange only works if the upstream serves CORS on its
    // token endpoint. Compiled-in brokers are required to; an operator's own
    // provider has to be configured for a single-page app, which is the same
    // requirement said in the provider's own words.
    throw new FederationError(
      "upstream_unavailable",
      `Could not reach the token endpoint at ${pending.issuer}. It has to allow browser requests — in most providers that means registering this app as a single-page or public client.`,
    );
  }
  context.assertCurrent();
  if (!response.ok) {
    throw new FederationError(
      "exchange_failed",
      `${pending.issuer} refused the code exchange (${response.status}).`,
    );
  }

  const tokens: { id_token?: BoundaryValue; access_token?: BoundaryValue } =
    overlapCast(await response.json());
  context.assertCurrent();
  if (!isString(tokens.id_token)) {
    throw new FederationError(
      "exchange_failed",
      `${pending.issuer} returned no id_token.`,
    );
  }

  await verifyConfiguredIdentityToken(tokens.id_token, pending, pinned.jwksUri);
  context.assertCurrent();
  const identity = readIdentity(
    tokens.id_token,
    pending,
    pinned.jwksUri,
    context,
  );
  // "We actually have an authorized user": where the broker offers a session
  // check (shoo does; its JWKS serves no CORS, so this is the one signature-
  // and revocation-backed answer a static page can get), ask it before the
  // identity is saved or handed to anyone. A refusal here is a refusal of the
  // whole sign-in.
  await requireActiveUpstreamSession(
    identity.idToken,
    pinned.sessionCheckEndpoint,
    pending.issuer,
    context,
  );
  // Only the brokered issuer's access token is ever carried out of here: it is
  // the one this app is entitled to spend, at the one endpoint that accepts it.
  const brokered =
    !pending.orgSlug &&
    context.issuerBrokered(pending.issuer) &&
    isString(tokens.access_token);
  const result = {
    identity,
    returnTo: assertSafeReturnTo(pending.returnTo, context.origin, "/"),
    orgSlug: pending.orgSlug,
    orgMethod: pending.orgMethod,
    ...(brokered && isString(tokens.access_token)
      ? { accessToken: tokens.access_token }
      : undefined),
  };
  // Org SSO/SAML is a one-shot assertion for Identity join, not a durable
  // Pages federation session. Saving it would collide with Shoo/mock sign-in.
  context.assertCurrent();
  if (!pending.orgSlug) context.save(identity);
  return result;
}
