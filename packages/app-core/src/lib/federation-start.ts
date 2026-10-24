/** Deferred explicit sign-in actions; synchronous ownership and public inputs are captured by the facade. */
import { isString, overlapCast } from "@opensesame/os-domain";
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import { ambientAuthSeams } from "./ambient-auth-seam.js";
import { assertSafeReturnTo } from "./federation-callback.js";
import {
  applyConfiguredIdentityNonce,
  configuredIdentityNonce,
} from "./federation-configured-token.js";
import type {
  BeginSignInOptions,
  OidcDiscovery,
  TrustedUpstream,
} from "./federation-contract.js";
import { FederationError } from "./federation-error.js";
import { storePending } from "./federation-pending.js";

export type FederationStartOwner = Readonly<{
  origin: string;
  assertCurrent: () => void;
}>;
export type FederationStartContext = Readonly<{
  upstream: Readonly<TrustedUpstream>;
  options: Readonly<BeginSignInOptions>;
  owner: FederationStartOwner;
  redirectUri: string;
  clientId: string;
  navigate: (url: string) => void;
}>;

type Pkce = { verifier: string; challenge: string };

async function createPkce(): Promise<Pkce> {
  const verifier = randomString(32);
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

export async function discoverCaptured(
  issuer: string,
  owner: FederationStartOwner,
): Promise<OidcDiscovery> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let response: Response;
  owner.assertCurrent();
  try {
    response = await fetch(url, { credentials: "omit" });
  } catch {
    throw new FederationError(
      "upstream_unavailable",
      `Could not reach ${issuer}.`,
    );
  }
  owner.assertCurrent();
  if (!response.ok) {
    throw new FederationError(
      "upstream_unavailable",
      `${issuer} returned ${response.status} for its discovery document.`,
    );
  }
  const doc: Partial<OidcDiscovery> = overlapCast(await response.json());
  owner.assertCurrent();
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
    issuer: isString(doc.issuer) ? doc.issuer : issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
  };
}

/** Compiled brokers skip CORS discovery; operator-brought issuers still fetch. */
function discoveryFor(
  upstream: TrustedUpstream,
  owner: FederationStartOwner,
): Promise<OidcDiscovery> {
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
  return discoverCaptured(upstream.issuer, owner);
}

/**
 * Send the browser to the upstream. Returns nothing because it navigates: the
 * flow resumes in `completeSignIn` after the redirect back.
 */
export async function beginCapturedSignIn(
  context: FederationStartContext,
): Promise<void> {
  const { upstream, options, owner } = context;
  const { performSavedCategory } = await import("./feature-request-send.js");
  owner.assertCurrent();
  performSavedCategory(["identity"]);
  owner.assertCurrent();
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
  const discovery = await discoveryFor(upstream, owner);
  owner.assertCurrent();
  const { verifier, challenge } = await createPkce();
  owner.assertCurrent();
  const state = randomString(16);
  const nonce = configuredIdentityNonce(upstream.id);
  // An operator's own provider needs a subject and a name to be worth signing
  // in with; the origin-profile brokers have always answered `openid` alone.
  const scope =
    options.scope ??
    upstream.scope ??
    (upstream.clientId ? "openid profile email" : "openid");
  // Brokered legs return to the Identity API's registered canonical callback;
  // direct legs to the app base the loopback/mock brokers accept — which is
  // also the URI an operator registers at their own provider.
  const returnUri = context.redirectUri;
  const safeReturnTo = options.returnTo
    ? assertSafeReturnTo(options.returnTo, owner.origin, "/")
    : undefined;
  if (options.returnTo && !safeReturnTo)
    throw new FederationError(
      "invalid_request",
      "That return address is not part of this app.",
    );
  const clientId = context.clientId;

  owner.assertCurrent();
  storePending({
    upstreamId: upstream.id,
    issuer: discovery.issuer,
    verifier,
    state,
    nonce,
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
  applyConfiguredIdentityNonce(url, nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  applyAuthorizeDialect(url, upstream, options, scope);
  owner.assertCurrent();
  context.navigate(url.toString());
}

function applyAuthorizeDialect(
  url: URL,
  upstream: TrustedUpstream,
  options: BeginSignInOptions,
  scope: string,
): void {
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
    const providerHint = options.providerHint ?? upstream.providerHint;
    if (providerHint) {
      // Both names, because the hosted login page reads either one and the
      // SDK has always sent both.
      url.searchParams.set("kc_idp_hint", providerHint);
      url.searchParams.set("login_hint_provider", providerHint);
    }
    if (options.loginHint)
      url.searchParams.set("login_hint", options.loginHint);
    if (options.prompt) url.searchParams.set("prompt", options.prompt);
  }
}
