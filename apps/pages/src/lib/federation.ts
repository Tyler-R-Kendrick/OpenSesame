import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Federated sign-in against a trusted upstream broker (ADR 0033).
 *
 * This app is a static deployment: it has no server, so it holds no client
 * secret and mints nothing. It is a public OAuth client whose `client_id` is
 * derived from its own origin, and the identity it ends up with was signed by
 * the upstream, not here.
 *
 * The wire contract is docs/architecture/federated-signin.md §1.
 */

const PKCE_KEY = "opensesame:federation:pkce";
const SESSION_KEY = "opensesame:federation:session";

export type TrustedUpstream = {
  id: string;
  displayName: string;
  issuer: string;
  /** What the human is actually signing in with, said plainly on the button. */
  accountKind: string;
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
  },
  {
    id: "mock",
    displayName: "Local mock IdP",
    issuer: "http://127.0.0.1:9090",
    accountKind: "a seeded test account",
  },
];

/**
 * Loopback deployments are development, where reaching the public broker would
 * be both wrong and usually impossible; anything else is the real thing.
 */
function defaultUpstreamDefault(): TrustedUpstream {
  const local =
    location !== undefined &&
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const wanted = local ? "mock" : "shoo";
  const found = TRUSTED_UPSTREAMS.find((u) => u.id === wanted);
  if (!found) throw new Error(`no trusted upstream "${wanted}"`);
  return found;
}

export function upstreamByIssuer(issuer: string): TrustedUpstream | undefined {
  return TRUSTED_UPSTREAMS.find((u) => u.issuer === issuer);
}

/** The client id this origin has at any origin-profile broker. */
export function originClientId(origin: string = location.origin): string {
  return `origin:${origin}`;
}

/**
 * Where the upstream sends the browser back. The app root rather than a deep
 * path: a static host has no router, and the origin is all the broker derives
 * the client id from, so the path buys nothing and costs a 404.
 */
export function redirectUri(): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${location.origin}${base}`;
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
  email?: string;
  name?: string;
  picture?: string;
};

function isUpstreamIdentity(value: BoundaryValue): value is UpstreamIdentity {
  return (
    isJsonObject(value) &&
    isString(value.issuer) &&
    isString(value.upstreamId) &&
    isString(value.idToken) &&
    isString(value.pairwiseSub) &&
    isString(value.audience) &&
    isString(value.jwksUri) &&
    isNumber(value.expiresAt)
  );
}

export class FederationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FederationError";
    this.code = code;
  }
}

function b64urlDecode(part: string): Uint8Array {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeJwtClaims(token: string): JsonObject {
  const payload = token.split(".")[1];
  if (!payload) throw new FederationError("invalid_token", "Not a JWT.");
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
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

async function createPkce(): Promise<{ verifier: string; challenge: string }> {
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

type PendingAuth = {
  upstreamId: string;
  issuer: string;
  verifier: string;
  state: string;
  tokenEndpoint: string;
  jwksUri: string;
  scope: string;
  /** Where to send the human once they are back, if they were mid-task. */
  returnTo?: string;
  /** Tenant slug when this round-trip is org SSO/SAML, not a global broker. */
  orgSlug?: string;
  orgMethod?: "sso" | "saml";
};

function storePending(pending: PendingAuth): void {
  // PKCE state must survive the upstream redirect in this static PWA.
  // ast-grep-ignore: ts-localstorage-set
  sessionStorage.setItem(PKCE_KEY, JSON.stringify(pending));
}

function takePending(): PendingAuth | null {
  const raw = sessionStorage.getItem(PKCE_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PKCE_KEY);
  try {
    return overlapCast(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Send the browser to the upstream. Returns nothing because it navigates: the
 * flow resumes in `completeSignIn` after the redirect back.
 */
export type BeginSignInOptions = {
  scope?: string;
  returnTo?: string;
  orgSlug?: string;
  orgMethod?: "sso" | "saml";
};

async function beginSignInDefault(
  upstream: TrustedUpstream,
  options: BeginSignInOptions = {},
): Promise<void> {
  const discovery = await discover(upstream.issuer);
  const { verifier, challenge } = await createPkce();
  const state = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const scope = options.scope ?? "openid";

  storePending({
    upstreamId: upstream.id,
    issuer: upstream.issuer,
    verifier,
    state,
    tokenEndpoint: discovery.token_endpoint,
    jwksUri: discovery.jwks_uri,
    scope,
    returnTo: options.returnTo,
    orgSlug: options.orgSlug,
    orgMethod: options.orgMethod,
  });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", originClientId());
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", scope);
  location.assign(url.toString());
}

/** True when the current URL looks like an upstream sending the browser back. */
export function hasAuthResponse(search: string = location.search): boolean {
  const params = new URLSearchParams(search);
  return params.has("code") || params.has("error");
}

export type CompletedSignIn = {
  identity: UpstreamIdentity;
  /** In-app path to resume (e.g. broker/authorize query) after upstream return. */
  returnTo?: string;
  orgSlug?: string;
  orgMethod?: "sso" | "saml";
};

/**
 * Finish a redirect that `beginSignIn` started. Returns null when this load is
 * not an upstream response, so it is safe to call on every startup.
 */
async function completeSignInDefault(): Promise<CompletedSignIn | null> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  const state = params.get("state");
  if (!code && !error) return null;

  const pending = takePending();
  clearAuthResponseFromUrl();

  if (error) {
    throw new FederationError(
      error,
      params.get("error_description") ?? `The broker refused: ${error}.`,
    );
  }
  if (!pending) {
    throw new FederationError(
      "invalid_request",
      "No sign-in was in progress in this tab.",
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
    redirect_uri: redirectUri(),
    client_id: originClientId(),
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
    // token endpoint, which is a stated requirement of a trusted broker.
    throw new FederationError(
      "upstream_unavailable",
      `Could not reach the token endpoint at ${pending.issuer}. A trusted broker must serve CORS there.`,
    );
  }
  if (!response.ok) {
    throw new FederationError(
      "exchange_failed",
      `${pending.issuer} refused the code exchange (${response.status}).`,
    );
  }

  const tokens: { id_token?: BoundaryValue } = overlapCast(
    await response.json(),
  );
  if (!isString(tokens.id_token)) {
    throw new FederationError(
      "exchange_failed",
      `${pending.issuer} returned no id_token.`,
    );
  }

  const identity = readIdentity(tokens.id_token, pending);
  // Org SSO/SAML is a one-shot assertion for Identity join, not a durable
  // Pages federation session. Saving it would collide with Shoo/mock sign-in.
  if (!pending.orgSlug) saveSession(identity);
  return {
    identity,
    returnTo: pending.returnTo,
    orgSlug: pending.orgSlug,
    orgMethod: pending.orgMethod,
  };
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
  if (!pending.orgSlug && !upstreamByIssuer(issuer)) {
    throw new FederationError(
      "untrusted_issuer",
      `${issuer} is not a trusted broker.`,
    );
  }

  const expected = originClientId();
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

  const pairwiseSub = isString(claims.pairwise_sub)
    ? claims.pairwise_sub
    : pending.orgSlug && isString(claims.sub)
      ? claims.sub
      : "";
  if (!pairwiseSub) {
    throw new FederationError(
      "invalid_token",
      pending.orgSlug
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
  const url = new URL(location.href);
  for (const key of ["code", "state", "error", "error_description", "scope"]) {
    url.searchParams.delete(key);
  }
  history.replaceState(null, "", url.toString());
}

/**
 * sessionStorage rather than localStorage: the assertion must not outlive the
 * browser session as durable XSS-exfiltrable material, but it does have to
 * survive the upstream redirect and popup navigations within this tab.
 */
export function saveSession(identity: UpstreamIdentity): void {
  // The verified assertion must survive same-tab navigation but not the tab.
  // ast-grep-ignore: ts-localstorage-set
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(identity));
}

function loadSessionDefault(): UpstreamIdentity | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const identity: BoundaryValue = JSON.parse(raw);
    if (!isUpstreamIdentity(identity)) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    if (identity.expiresAt <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    if (!upstreamByIssuer(identity.issuer)) {
      // Trust can be withdrawn between sessions; a stored identity from an
      // issuer no longer listed must not keep working.
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}

function clearSessionDefault(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

function displayNameDefault(identity: UpstreamIdentity): string {
  return identity.name ?? identity.email ?? identity.pairwiseSub;
}

export const federationSeams = {
  defaultUpstream: defaultUpstreamDefault,
  beginSignIn: beginSignInDefault,
  completeSignIn: completeSignInDefault,
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

export function loadSession(): UpstreamIdentity | null {
  return federationSeams.loadSession();
}

export function clearSession(): void {
  federationSeams.clearSession();
}

export function displayName(identity: UpstreamIdentity): string {
  return federationSeams.displayName(identity);
}
