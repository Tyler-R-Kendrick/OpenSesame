import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { decodeJwtEnvelope } from "@opensesame/sdk-browser";
import type { VerifiedIdTokenClaims } from "@opensesame/sdk-browser";
import { env } from "../host.js";
import { page, pageOrigin } from "../ports.js";
import { ambientAuthSeams } from "./ambient-auth-seam.js";
import type { AuthenticationIntent } from "./ambient-auth/types.js";
import { parseAuthCallback } from "./federation-callback.js";
import { b64urlDecode, b64urlEncode } from "./federation-encoding.js";
import {
  type PendingAuth,
  storePending,
  takeMatchingPending,
} from "./federation-pending.js";
import { readStoredSessionSync } from "./federation-restoration.js";
import {
  clearFederationSessionJson,
  readFederationSessionJson,
  writeFederationSessionJson,
} from "./federation-session-store.js";
import {
  type IdentitySession,
  remoteIdentityApi,
  restoreSession,
} from "./identity.js";
import { rememberLastSignIn } from "./last-sign-in.js";
import { localNetworkFetch } from "./local-network-fetch.js";
import { type OperatorIdp, signInMethods } from "./settings.js";
/**
 * Federated sign-in against a trusted upstream broker (ADR 0033).
 *
 * This app is a static deployment: it has no server, so it holds no client
 * secret and mints nothing. It is a public OAuth client whose `client_id` is
 * derived from its own origin, and the identity it ends up with was signed by
 * the upstream, not here. The wire contract is
 * docs/architecture/federated-signin.md §1.
 */
export type TrustedUpstream = {
  id: string;
  displayName: string;
  issuer: string;
  /** What the human is actually signing in with, said plainly on the button. */
  accountKind: string;
  /**
   * The OAuth client id to present, when it is not this origin's own profile.
   *
   * Compiled-in brokers and the Identity API both understand `origin:<origin>`
   * and mint a client for it on sight. A provider the operator brought — an
   * Okta org, an Auth0 tenant, an Entra directory — knows only the client it
   * was configured with, so that id travels with the upstream and is what the
   * `aud` claim is checked against (ADR 0078).
   */
  clientId?: string;
  /**
   * Compiled OIDC endpoints. A static page cannot discover these when the
   * broker omits CORS on `/.well-known/openid-configuration` (shoo.dev serves
   * CORS on `POST /token` and `POST /session/check` only). Authorization is a
   * top-level navigation, so it needs no CORS; the token POST already allows
   * this origin.
   */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  /**
   * Shoo speaks its own, deliberately small authorize dialect — exactly what
   * its official clients (`shoo.js`, `@shoojs/auth`) send: `client_id`,
   * `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`,
   * and `pii=true` when profile data is wanted. There is no `response_type`
   * and no `scope`; profile consent is the `pii` flag, never a scope string.
   * Everything else here speaks standard OIDC.
   */
  protocol?: "shoo" | "oidc";
  /**
   * Where a live "is this user still authorized?" answer comes from. Shoo's
   * JWKS endpoint serves no CORS, so this static page cannot verify the ES256
   * signature itself; `POST /session/check` with the id_token as bearer is the
   * check the broker built for browsers — its server verifies the signature
   * and the revocation list and answers active/login_required.
   */
  sessionCheckEndpoint?: string | undefined;
};
/**
 * Trust is configuration, not discovery: an issuer absent from this list is
 * refused even if it completes a flow correctly (ADR 0033 §2).
 */
export const TRUSTED_UPSTREAMS: readonly TrustedUpstream[] = [
  {
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google",
    authorizationEndpoint: "https://shoo.dev/authorize",
    tokenEndpoint: "https://shoo.dev/token",
    jwksUri: "https://shoo.dev/.well-known/jwks.json",
    protocol: "shoo",
    sessionCheckEndpoint: "https://shoo.dev/session/check",
  },
  {
    // Hermetic tests name this upstream explicitly. It is never the product
    // default — first run signs in through Shoo, which is a real OIDC broker.
    id: "mock",
    displayName: "Local mock IdP",
    issuer: "http://127.0.0.1:9090",
    accountKind: "a test account",
    authorizationEndpoint: "http://127.0.0.1:9090/authorize",
    tokenEndpoint: "http://127.0.0.1:9090/token",
    jwksUri: "http://127.0.0.1:9090/jwks",
  },
];

/**
 * The compiled-in broker is Shoo on every origin, including loopback.
 *
 * A self-hosted Identity API is optional plumbing (org SSO, SAML, magic
 * link, guest). It is not a requirement for first-run sign-in: this static
 * page is a public OIDC client of Shoo, which fronts Google — including
 * Google passkeys — and already serves CORS on `POST /token` for this origin.
 * The mock IdP stays in the allowlist so hermetic tests can name it.
 */
function defaultUpstreamDefault(): TrustedUpstream {
  const found = TRUSTED_UPSTREAMS.find((u) => u.id === "shoo");
  if (!found) throw new Error('no trusted upstream "shoo"');
  return found;
}

export function upstreamByIssuer(issuer: string): TrustedUpstream | undefined {
  return TRUSTED_UPSTREAMS.find((u) => u.issuer === issuer);
}

/**
 * One operator-configured provider, as an upstream this app runs the code flow
 * against directly (ADR 0078).
 *
 * This is the road that makes an external IdP *be* the identity service. It
 * needs no OpenSesame identity service behind it: the browser is a public
 * OAuth client, PKCE binds the exchange, and the provider's own discovery
 * document supplies every endpoint. Its `clientId` is whatever the operator
 * registered for this origin at their provider — configuration, never a
 * credential, and useless without the redirect URI it is bound to.
 */
export function operatorUpstream(idp: OperatorIdp): TrustedUpstream {
  return {
    id: `operator:${idp.issuer}`,
    displayName: idp.label,
    issuer: idp.issuer,
    accountKind: idp.label,
    clientId: idp.clientId,
  };
}

/**
 * An operator's own provider is a trusted issuer for this deployment.
 *
 * `TRUSTED_UPSTREAMS` is compiled in because a *runtime-discovered* issuer
 * must never become trusted by completing a flow (ADR 0033 §2). This is the
 * other case: an issuer the operator durably configured, which is the same
 * trust relationship the configured Identity API already has in
 * `isBrokeredIssuer` — somebody with the deployment's settings said "this one
 * speaks for my users". It admits exactly the stored issuers, never whatever a
 * response happens to claim.
 */
export function isOperatorIdpIssuer(issuer: string): boolean {
  const wanted = trimSlashes(issuer);
  return signInMethods().providers.some(
    (idp) => trimSlashes(idp.issuer) === wanted,
  );
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The configured Identity API is a trusted issuer for this app (C11).
 *
 * It is not in `TRUSTED_UPSTREAMS` because it is not compiled in: it is
 * whatever the Settings store points at, and it is the one runtime issuer this
 * app already trusts with everything else — sessions, principals, org joins.
 * Brokered sign-in (D7/D8) is that same relationship, so its assertions are
 * admitted here and nowhere else. This is deliberately NOT the `orgSlug`
 * allowlist skip in `readIdentity`, which admits any runtime-constructed
 * upstream and is left exactly as narrow as it was (T18).
 */
export function isBrokeredIssuer(issuer: string): boolean {
  const base = trimSlashes(remoteIdentityApi());
  // An unconfigured remote Identity API is "" and must not make the
  // device-native Pages origin a trusted brokered issuer.
  return base.length > 0 && trimSlashes(issuer) === base;
}

/** The client id this origin has at any origin-profile broker. */
export function originClientId(origin: string = pageOrigin()): string {
  return `origin:${origin}`;
}

/**
 * Where the upstream sends the browser back. The app root rather than a deep
 * path: a static host has no router, and the origin is all the broker derives
 * the client id from, so the path buys nothing and costs a 404.
 */
export function redirectUri(): string {
  const base = env().BASE_URL || "/";
  return `${pageOrigin()}${base}`;
}

/**
 * The ONE redirect URI the Identity API's auto-admitted origin client has:
 * `<origin>/opensesame/callback` (ADR 0050's canonical callback path). Every
 * brokered leg must use it — the base-path URI above is unregistered there
 * and dies at the authorize endpoint as an invalid redirect_uri, which is
 * exactly how every brokered button used to dead-end. GitHub Pages serves
 * this path through the 404 SPA fallback (the project prefix is matched
 * case-insensitively), and the dev server redirects it onto the base; either
 * way the app boots, sees `?code`, and finishes on the federation return
 * screen, which never cared what path it renders at.
 */
export function originCallbackUri(): string {
  return `${pageOrigin()}/opensesame/callback`;
}

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type UpstreamIdentity = {
  issuer: string;
  upstreamId: string;
  idToken: string;
  /** Per-origin and stable; the identity this app knows the human by. */
  pairwiseSub: string;
  audience: string;
  jwksUri: string;
  expiresAt: number;
  email?: string | undefined;
  name?: string | undefined;
  picture?: string | undefined;
};

export class FederationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FederationError";
    this.code = code;
  }
}

export function decodeJwtClaims(token: string): JsonObject {
  const payload = token.split(".")[1];
  if (!payload) throw new FederationError("invalid_token", "Not a JWT.");
  try {
    return decodeJwtEnvelope(token).claims;
  } catch {
    throw new FederationError("invalid_token", "Token payload is not JSON.");
  }
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return new Uint8Array(digest);
}

/**
 * The subject a relying party at `origin` derives for itself, per
 * docs/architecture/federated-signin.md §3. Computed the same way here only so
 * the consent screen can show what an origin will learn.
 */
export async function derivedSubjectFor(
  pairwiseSub: string,
  origin: string,
): Promise<string> {
  return b64urlEncode(await sha256(`${pairwiseSub}:${origin}`));
}

type Pkce = { verifier: string; challenge: string };

async function createPkce(): Promise<Pkce> {
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64urlEncode(await sha256(verifier)) };
}

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetch(url, { credentials: "omit" });
  } catch {
    throw new FederationError(
      "upstream_unavailable",
      `Could not reach ${issuer}.`,
    );
  }
  if (!response.ok) {
    throw new FederationError(
      "upstream_unavailable",
      `${issuer} returned ${response.status} for its discovery document.`,
    );
  }
  const doc: Partial<OidcDiscovery> = overlapCast(await response.json());
  if (
    !isString(doc.authorization_endpoint) ||
    !isString(doc.token_endpoint) ||
    !isString(doc.jwks_uri)
  ) {
    throw new FederationError(
      "upstream_unavailable",
      `${issuer} published an incomplete discovery document.`,
    );
  }
  // An issuer that names someone else is either misconfigured or hostile, and
  // either way its endpoints cannot be trusted to belong to it.
  if (
    doc.issuer &&
    doc.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")
  ) {
    throw new FederationError(
      "issuer_mismatch",
      `${issuer} claims to be ${doc.issuer}.`,
    );
  }
  return {
    issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
  };
}

/** Compiled brokers skip CORS discovery; operator-brought issuers still fetch. */
function discoveryFor(upstream: TrustedUpstream): Promise<OidcDiscovery> {
  if (
    upstream.authorizationEndpoint &&
    upstream.tokenEndpoint &&
    upstream.jwksUri
  ) {
    return Promise.resolve({
      issuer: upstream.issuer,
      authorization_endpoint: upstream.authorizationEndpoint,
      token_endpoint: upstream.tokenEndpoint,
      jwks_uri: upstream.jwksUri,
    });
  }
  return discover(upstream.issuer);
}

/**
 * Send the browser to the upstream. Returns nothing because it navigates: the
 * flow resumes in `completeSignIn` after the redirect back.
 */
export type BeginSignInOptions = {
  scope?: string;
  returnTo?: string | undefined;
  orgSlug?: string | undefined;
  orgMethod?: "sso" | "saml" | undefined;
  /**
   * Which provider the brokered login page should pre-select. Sent under both
   * spellings the hosted page accepts, exactly as `packages/sdk-browser` does.
   */
  providerHint?: string;
  /**
   * Standard OIDC `login_hint`, carrying ONLY an email domain for home-realm
   * discovery (D12). The local part never reaches this function — see
   * `workEmailDomain` in `providers.ts` — so nothing personal ends up in the
   * address bar, in history, or in the hosted page's request log (T28).
   */
  loginHint?: string;
  /**
   * Standard OIDC `prompt=login` (Core §3.1.2.1): the issuer must ask the
   * person to authenticate again instead of reusing the session it still
   * holds. This is what "switch account" needs, or a second sign-in would
   * silently come back as the same person. Every OIDC issuer supports it.
   * Shoo does not read `prompt` at all (docs.shoo.dev), so on that dialect
   * it is not sent: shoo.dev answers with the Google account it remembers,
   * and a different one means signing out at shoo.dev/me first.
   */
  prompt?: "login";
};

async function beginSignInDefault(
  upstream: TrustedUpstream,
  options: BeginSignInOptions = {},
): Promise<void> {
  // A brokered upstream built from an unconfigured Identity API carries an
  // empty issuer. Refusing here, before any navigation, is what keeps the
  // failure on-screen instead of a blank-issuer discovery 404 after the fact.
  if (!upstream.issuer.trim()) {
    throw new FederationError(
      "no_identity_api",
      "This deployment isn't connected to an identity service yet, so this sign-in can't start.",
    );
  }
  ambientAuthSeams.clearAutoAuthSuppression();
  const discovery = await discoveryFor(upstream);
  const { verifier, challenge } = await createPkce();
  const state = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  // An operator's own provider needs a subject and a name to be worth signing
  // in with; the origin-profile brokers have always answered `openid` alone.
  const scope =
    options.scope ?? (upstream.clientId ? "openid profile email" : "openid");
  // Brokered legs return to the Identity API's registered canonical callback;
  // direct legs to the app base the loopback/mock brokers accept — which is
  // also the URI an operator registers at their own provider.
  const returnUri = isBrokeredIssuer(upstream.issuer)
    ? originCallbackUri()
    : redirectUri();
  const clientId = upstream.clientId ?? originClientId();

  storePending({
    upstreamId: upstream.id,
    issuer: upstream.issuer,
    verifier,
    state,
    tokenEndpoint: discovery.token_endpoint,
    jwksUri: discovery.jwks_uri,
    scope,
    sessionCheckEndpoint: upstream.sessionCheckEndpoint,
    redirectUri: returnUri,
    clientId,
    returnTo: options.returnTo,
    orgSlug: options.orgSlug,
    orgMethod: options.orgMethod,
  });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", returnUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (upstream.protocol === "shoo") {
    // Shoo's authorize dialect (docs.shoo.dev): the five parameters above plus
    // an opt-in `pii` flag. No `response_type`, no `scope` — profile data is
    // consent on shoo's side, not a scope string, and asking with a scope
    // grants nothing.
    if (/\b(profile|email)\b/.test(scope)) {
      url.searchParams.set("pii", "true");
    }
  } else {
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    if (options.providerHint) {
      // Both names, because the hosted login page reads either one and the
      // SDK has always sent both.
      url.searchParams.set("kc_idp_hint", options.providerHint);
      url.searchParams.set("login_hint_provider", options.providerHint);
    }
    if (options.loginHint)
      url.searchParams.set("login_hint", options.loginHint);
    if (options.prompt) url.searchParams.set("prompt", options.prompt);
  }
  page().location.assign(url.toString());
}

/** True when the current URL looks like an upstream sending the browser back. */
export function hasAuthResponse(search = page().location.search): boolean {
  const params = new URLSearchParams(search);
  if (params.has("github_app") || params.has("github_app_code")) return false;
  return params.has("code") || params.has("error");
}

export type CompletedSignIn = {
  identity: UpstreamIdentity;
  /** In-app path to resume (e.g. broker/authorize query) after upstream return. */
  returnTo?: string | undefined;
  orgSlug?: string | undefined;
  orgMethod?: "sso" | "saml" | undefined;
  /**
   * The OAuth access token from the exchange, present only when the issuer was
   * the Identity API itself — the brokered flow (D8). It is the credential
   * `adoptBrokeredSession` trades for a first-party session bound to the SAME
   * principal the hosted leg admitted. The id_token from that flow carries a
   * pairwise subject for this origin and must never be linked to whatever
   * session this tab happens to hold (T23).
   */
  accessToken?: string;
  /** Saved before navigation; ambient completion must not infer this. */
  intent?: AuthenticationIntent;
  transactionId?: string;
  generation?: number;
  policyRevision?: string;
  claims?: VerifiedIdTokenClaims;
};

/**
 * Ask the upstream whether this token is actually authorized, when it offers
 * a way to ask (shoo's CORS-enabled `POST /session/check`).
 *
 * Only the upstream's explicit "no" — a 401 with a reason — refuses the
 * sign-in: that answer is signature-verified and revocation-aware on the
 * broker's side, which is exactly the verification this static page cannot do
 * itself (the JWKS endpoint serves no CORS). A missing endpoint (404/501 from
 * an older broker) or a transport failure does not invalidate a token that
 * just arrived from the same broker's token endpoint over TLS; claims were
 * already checked in `readIdentity`.
 */
async function requireActiveUpstreamSession(
  idToken: string,
  pending: PendingAuth,
): Promise<void> {
  const endpoint =
    pending.sessionCheckEndpoint ??
    upstreamByIssuer(pending.issuer)?.sessionCheckEndpoint;
  if (!endpoint) return;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${idToken}` },
      credentials: "omit",
    });
  } catch {
    return;
  }
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
  throw new FederationError(
    "login_required",
    reason === "expired"
      ? "That sign-in expired before it could finish. Try again."
      : `${pending.issuer} says this sign-in is not authorized (${reason}). Sign in again.`,
  );
}

/**
 * Finish a redirect that `beginSignIn` started. Returns null when this load is
 * not an upstream response, so it is safe to call on every startup.
 */
async function completeSignInDefault(): Promise<CompletedSignIn | null> {
  const parsed = parseAuthCallback(page().location.search);
  if (parsed.kind === "none") return null;
  if (parsed.kind === "malformed") {
    clearAuthResponseFromUrl();
    throw new FederationError(
      parsed.reason,
      "This sign-in response was not usable.",
    );
  }
  const state = parsed.state;
  const { pending, stale, unmatched } = takeMatchingPending(state);
  clearAuthResponseFromUrl();

  if (unmatched) {
    throw new FederationError(
      "invalid_request",
      "Sign-in state did not match.",
    );
  }
  if (parsed.kind === "error") {
    throw new FederationError(
      parsed.error,
      parsed.description ?? `The broker refused: ${parsed.error}.`,
    );
  }
  const code = parsed.code;
  if (!pending) {
    // A code with NO pending record at all is usually a replay — the callback
    // URL reopened from history or a bookmark after the sign-in already
    // finished. When a live session exists, this load is not a failed sign-in
    // and must not be turned into one: the code is already spent (or somebody
    // else's), the person is signed in, and the app just proceeds. A STALE
    // record is different: a real ceremony was in flight and went bad, so it
    // is refused out loud even beside a live session — silence here would
    // discard an account-switch sign-in without a word.
    if (!stale && loadSessionDefault()) return null;
    throw new FederationError(
      "invalid_request",
      "This sign-in expired or started somewhere else. Start again from the sign-in screen.",
    );
  }
  // Binds the response to the request this tab made; without it a link could
  // drop someone else's code here.
  if (!state || state !== pending.state) {
    throw new FederationError(
      "invalid_request",
      "Sign-in state did not match.",
    );
  }
  if (!code) {
    throw new FederationError(
      "invalid_request",
      "The broker returned no code.",
    );
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    // Byte-identical to what the authorize request carried, whichever shape
    // that was — token endpoints compare, not resolve.
    redirect_uri: pending.redirectUri ?? redirectUri(),
    client_id: pending.clientId ?? originClientId(),
    code_verifier: pending.verifier,
  });

  let response: Response;
  try {
    response = await fetch(pending.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
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
  if (!response.ok) {
    throw new FederationError(
      "exchange_failed",
      `${pending.issuer} refused the code exchange (${response.status}).`,
    );
  }

  const tokens: { id_token?: BoundaryValue; access_token?: BoundaryValue } =
    overlapCast(await response.json());
  if (!isString(tokens.id_token)) {
    throw new FederationError(
      "exchange_failed",
      `${pending.issuer} returned no id_token.`,
    );
  }

  const identity = readIdentity(tokens.id_token, pending);
  // "We actually have an authorized user": where the broker offers a session
  // check (shoo does; its JWKS serves no CORS, so this is the one signature-
  // and revocation-backed answer a static page can get), ask it before the
  // identity is saved or handed to anyone. A refusal here is a refusal of the
  // whole sign-in.
  await requireActiveUpstreamSession(identity.idToken, pending);
  // Org SSO/SAML is a one-shot assertion for Identity join, not a durable
  // Pages federation session. Saving it would collide with Shoo/mock sign-in.
  if (!pending.orgSlug) saveSession(identity);
  // Only the brokered issuer's access token is ever carried out of here: it is
  // the one this app is entitled to spend, at the one endpoint that accepts it.
  const brokered =
    !pending.orgSlug &&
    isBrokeredIssuer(pending.issuer) &&
    isString(tokens.access_token);
  return {
    identity,
    returnTo: pending.returnTo,
    orgSlug: pending.orgSlug,
    orgMethod: pending.orgMethod,
    ...(brokered && isString(tokens.access_token)
      ? { accessToken: tokens.access_token }
      : undefined),
  };
}

/**
 * Trade the brokered access token for a first-party session (C13/D8).
 *
 * The Identity API looks the token up in its own store, reads the principal it
 * was issued for, and mints a provisional bearer for that same principal. No
 * identity row is written and no principal is minted — which is exactly why
 * this, and not `link-identities`, is the brokered adoption path (T23).
 */
async function adoptBrokeredSessionDefault(
  accessToken: string,
): Promise<IdentitySession> {
  const base = remoteIdentityApi();
  if (!base) {
    throw new FederationError(
      "no_identity_api",
      "No sign-in service is connected, so this sign-in cannot be adopted.",
    );
  }
  let response: Response;
  try {
    response = await localNetworkFetch(
      `${base}/v1/principals/federated-session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The token IS the credential here; a cookie beside it would let a
        // surviving session answer in its place.
        credentials: "omit",
        body: JSON.stringify({ accessToken }),
      },
    );
  } catch {
    throw new FederationError(
      "identity_unavailable",
      `Could not reach the sign-in service at ${base} to finish signing in.`,
    );
  }
  if (!response.ok) {
    throw new FederationError(
      "session_adoption_failed",
      response.status === 401
        ? "That sign-in expired before it could be adopted. Try again."
        : `The sign-in service refused the sign-in (${response.status}).`,
    );
  }
  const body: {
    principalId?: BoundaryValue;
    accessToken?: BoundaryValue;
    expiresAt?: BoundaryValue;
  } = overlapCast(await response.json());
  if (!isString(body.principalId) || !isString(body.accessToken)) {
    throw new FederationError(
      "session_adoption_failed",
      "The sign-in service returned an unusable session.",
    );
  }
  const session: IdentitySession = {
    principalId: body.principalId,
    accessToken: body.accessToken,
    issuerOrigin: new URL(base).origin,
    ...(isString(body.expiresAt) ? { expiresAt: body.expiresAt } : undefined),
  };
  restoreSession(session);
  return session;
}

/**
 * Claims are checked; the signature is not re-checked here. The token arrived
 * over TLS directly from the token endpoint in response to this tab's own
 * PKCE-bound request, which is the case OpenID Connect Core §3.1.3.7 allows to
 * skip signature validation for. Relying parties are in a different position —
 * they receive it second-hand — and must verify it properly (§3 of the wire
 * contract).
 */
function readIdentity(idToken: string, pending: PendingAuth): UpstreamIdentity {
  const claims = decodeJwtClaims(idToken);
  const issuer = isString(claims.iss) ? claims.iss : "";
  if (issuer.replace(/\/+$/, "") !== pending.issuer.replace(/\/+$/, "")) {
    throw new FederationError(
      "issuer_mismatch",
      `Token was issued by ${issuer || "nobody"}, not ${pending.issuer}.`,
    );
  }
  if (
    !pending.orgSlug &&
    !upstreamByIssuer(issuer) &&
    !isBrokeredIssuer(issuer) &&
    !isOperatorIdpIssuer(issuer)
  ) {
    throw new FederationError(
      "untrusted_issuer",
      `${issuer} is not a trusted broker.`,
    );
  }

  const expected = pending.clientId ?? originClientId();
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
    Boolean(pending.orgSlug) ||
    isBrokeredIssuer(issuer) ||
    isOperatorIdpIssuer(issuer);
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

  return {
    issuer,
    upstreamId: pending.upstreamId,
    idToken,
    pairwiseSub,
    audience: expected,
    jwksUri: pending.jwksUri,
    expiresAt: exp * 1000,
    email: isString(claims.email) ? claims.email : undefined,
    name: isString(claims.name) ? claims.name : undefined,
    picture: isString(claims.picture) ? claims.picture : undefined,
  };
}

/** Strip the code out of the address bar so a reload cannot replay it. */
export function clearAuthResponseFromUrl(): void {
  const url = new URL(page().location.href);
  for (const key of ["code", "state", "error", "error_description", "scope"]) {
    url.searchParams.delete(key);
  }
  page().replaceUrl(url.toString());
}

/**
 * localStorage, like the pending record above and for the same reason: the
 * upstream round trip can finish in a different browsing context than it
 * started in (an installed PWA hands out-of-scope navigation to a browser
 * tab), and a session only the finishing tab can see leaves the app itself
 * signed out — the person signs in successfully and still lands on the
 * sign-in screen. This is also where shoo's official clients keep the same
 * identity. The stored assertion is bounded by its own `exp`, checked on
 * every load, and dropped the moment its issuer loses trust. The broker's
 * session check vetted it once, when the sign-in completed; an upstream
 * revocation after that takes effect only when `exp` passes.
 */
export function saveSession(identity: UpstreamIdentity): void {
  writeFederationSessionJson(JSON.stringify(identity));
  rememberLastSignIn(identity.upstreamId);
}

function issuerIsTrusted(issuer: string): boolean {
  return Boolean(
    upstreamByIssuer(issuer) ||
      isBrokeredIssuer(issuer) ||
      isOperatorIdpIssuer(issuer),
  );
}

function loadSessionDefault(): UpstreamIdentity | null {
  const raw = readFederationSessionJson();
  if (!raw) return null;
  const identity = readStoredSessionSync(raw, issuerIsTrusted);
  if (!identity) {
    clearSessionDefault();
    return null;
  }
  return identity;
}

function clearSessionDefault(): void {
  clearFederationSessionJson();
}

function displayNameDefault(identity: UpstreamIdentity): string {
  return identity.name ?? identity.email ?? identity.pairwiseSub;
}

async function completeSignInWired(): Promise<CompletedSignIn | null> {
  const { completeAmbientIfPresent } = await import(
    "./ambient-auth/complete.js"
  );
  const ambient = await completeAmbientIfPresent(page().location.search);
  if (ambient) {
    clearAuthResponseFromUrl();
    return ambient.completed;
  }
  return completeSignInDefault();
}

export const federationSeams = {
  defaultUpstream: defaultUpstreamDefault,
  beginSignIn: beginSignInDefault,
  completeSignIn: completeSignInWired,
  adoptBrokeredSession: adoptBrokeredSessionDefault,
  loadSession: loadSessionDefault,
  clearSession: clearSessionDefault,
  displayName: displayNameDefault,
};

export function defaultUpstream(): TrustedUpstream {
  return federationSeams.defaultUpstream();
}

export async function beginSignIn(
  upstream: TrustedUpstream,
  options: BeginSignInOptions = {},
): Promise<void> {
  return federationSeams.beginSignIn(upstream, options);
}

export async function completeSignIn(): Promise<CompletedSignIn | null> {
  return federationSeams.completeSignIn();
}

export async function adoptBrokeredSession(
  accessToken: string,
): Promise<IdentitySession> {
  return federationSeams.adoptBrokeredSession(accessToken);
}

export function loadSession(): UpstreamIdentity | null {
  return federationSeams.loadSession();
}

export function clearSession(): void {
  federationSeams.clearSession();
}

export function displayName(identity: UpstreamIdentity): string {
  return federationSeams.displayName(identity);
}
