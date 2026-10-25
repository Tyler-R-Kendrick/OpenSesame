import {
  type BoundaryValue,
  type JsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { decodeJwtEnvelope, sha256Base64Url } from "@opensesame/sdk-browser";
import { host } from "../host.js";
import { page, pageOrigin } from "../ports.js";
import { ambientAuthSeams } from "./ambient-auth-seam.js";
import { parseAuthCallback } from "./federation-callback.js";
import { configuredIdentitySessionTrusted } from "./federation-configured-token.js";
import type {
  BeginSignInOptions,
  CompletedSignIn,
  OidcDiscovery,
  TrustedUpstream,
} from "./federation-contract.js";
export type {
  BeginSignInOptions,
  CompletedSignIn,
  OidcDiscovery,
  TrustedUpstream,
} from "./federation-contract.js";
import {
  consumeBrokeredPublication,
  runOwnedFederationExchange,
} from "./federation-publication.js";
export {
  federationExchangeSeams,
  saveSession,
} from "./federation-publication.js";
import { FederationError } from "./federation-error.js";
import {
  type FederationSessionGeneration,
  type UpstreamIdentity,
  upstreamIdentityDisplayName as displayNameDefault,
  federationSessionGeneration,
  readNativeFederationSession,
} from "./federation-native-session.js";
import { isOperatorIdpIssuer } from "./federation-operator.js";
import {
  originCallbackUri,
  originClientId,
  redirectUri,
} from "./federation-origin.js";
import { takeMatchingPending } from "./federation-pending.js";
import { clearFederationSession as clearSessionDefault } from "./federation-retirement.js";
import { readFederationSessionJson } from "./federation-session-store.js";
import { readStoredSessionSync } from "./federation-stored-session.js";
import {
  type IdentitySession,
  identitySessionEpoch,
  remoteIdentityApi,
  restoreSession,
} from "./identity.js";
import { localNetworkFetch } from "./local-network-fetch.js";
import { signInMethods } from "./settings.js";
export {
  operatorUpstream,
  isOperatorIdpIssuer,
} from "./federation-operator.js";

export { FederationError } from "./federation-error.js";
export {
  originCallbackUri,
  originClientId,
  redirectUri,
} from "./federation-origin.js";

/**
 * Federated sign-in against a trusted upstream broker (ADR 0033).
 *
 * This app is a static deployment: it has no server, so it holds no client
 * secret and mints nothing. It is a public OAuth client whose `client_id` is
 * derived from its own origin, and the identity it ends up with was signed by
 * the upstream, not here. The wire contract is
 * docs/architecture/federated-signin.md §1.
 */
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

export type { UpstreamIdentity } from "./federation-native-session.js";

export function decodeJwtClaims(token: string): JsonObject {
  const payload = token.split(".")[1];
  if (!payload) throw new FederationError("invalid_token", "Not a JWT.");
  try {
    return decodeJwtEnvelope(token).claims;
  } catch {
    throw new FederationError("invalid_token", "Token payload is not JSON.");
  }
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
  return sha256Base64Url(`${pairwiseSub}:${origin}`);
}

export const federationStartSeams = {
  load: (): Promise<typeof import("./federation-start.js")> =>
    import("./federation-start.js"),
};

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const captured = captureFederationAction();
  const { discoverCaptured } = await federationStartSeams.load();
  captured.assertCurrent();
  return discoverCaptured(issuer, captured);
}

async function beginSignInDefault(
  upstream: TrustedUpstream,
  options: BeginSignInOptions = {},
): Promise<void> {
  const captured = captureFederationAction();
  const originalUpstream = Object.freeze({ ...upstream });
  const context = Object.freeze({
    upstream: originalUpstream,
    options: Object.freeze({ ...options }),
    owner: captured,
    redirectUri: isBrokeredIssuer(originalUpstream.issuer)
      ? originCallbackUri()
      : captured.redirectUri,
    clientId: originalUpstream.clientId ?? captured.clientId,
    navigate(url: string) {
      captured.assertCurrent();
      page().location.assign(url);
    },
  });
  const { beginCapturedSignIn } = await federationStartSeams.load();
  captured.assertCurrent();
  return beginCapturedSignIn(context);
}

export { hasAuthResponse } from "./federation-response.js";

function callbackTrust(): string {
  return JSON.stringify({
    upstreams: TRUSTED_UPSTREAMS,
    broker: remoteIdentityApi(),
    signIn: signInMethods(),
  });
}

/** Capture before action code loads; callback consumption/scrubbing still precede its own loader await. */
function captureFederationAction() {
  const originalHost = host();
  const { search, origin, href } = page().location;
  const generation = federationSessionGeneration();
  const trust = callbackTrust();
  const originalFetch = fetch;
  let expectedHref = href;
  const assertConfiguration = () => {
    if (
      host() !== originalHost ||
      pageOrigin() !== origin ||
      page().location.href !== expectedHref ||
      fetch !== originalFetch ||
      callbackTrust() !== trust
    )
      throw new FederationError(
        "invalid_request",
        "Identity configuration changed or callback was replaced during sign-in; start again",
      );
  };
  const assertCurrent = () => {
    if (federationSessionGeneration() !== generation)
      throw new FederationError(
        "sign_in_cancelled",
        "That sign-in was ended by a sign-out. Start again.",
      );
    assertConfiguration();
  };

  return Object.freeze({
    search,
    origin,
    generation,
    clientId: originClientId(origin),
    redirectUri: redirectUri(),
    assertCurrent,
    assertConfiguration,
    scrub() {
      assertCurrent();
      const url = new URL(expectedHref);
      for (const key of [
        "code",
        "state",
        "error",
        "error_description",
        "scope",
      ])
        url.searchParams.delete(key);
      expectedHref = url.toString();
      page().replaceUrl(expectedHref);
      assertCurrent();
    },
  });
}
type CallbackCapture = ReturnType<typeof captureFederationAction>;

/**
 * Finish a redirect that `beginSignIn` started. Returns null when this load is
 * not an upstream response, so it is safe to call on every startup.
 */
async function completeSignInDefault(
  captured: CallbackCapture,
): Promise<CompletedSignIn | null> {
  const parsed = parseAuthCallback(captured.search);
  if (parsed.kind === "none") return null;
  captured.assertCurrent();
  if (parsed.kind === "malformed") {
    captured.scrub();
    throw new FederationError(
      parsed.reason,
      "This sign-in response was not usable.",
    );
  }
  const state = parsed.state;
  const { pending, stale, unmatched } = takeMatchingPending(state);
  captured.scrub();

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
    redirect_uri: pending.redirectUri ?? captured.redirectUri,
    client_id: pending.clientId ?? captured.clientId,
    code_verifier: pending.verifier,
  });

  const context = Object.freeze({
    pending: Object.freeze({ ...pending }),
    body: body.toString(),
    origin: captured.origin,
    clientId: pending.clientId ?? captured.clientId,
    upstreams: Object.freeze(
      TRUSTED_UPSTREAMS.map((upstream) => Object.freeze({ ...upstream })),
    ),
    assertCurrent: captured.assertCurrent,
    decodeClaims: decodeJwtClaims,
    issuerTrusted: issuerIsTrusted,
    issuerBrokered: isBrokeredIssuer,
    subjectIsPairwise: (issuer: string) =>
      isBrokeredIssuer(issuer) || isOperatorIdpIssuer(issuer),
  });
  return runOwnedFederationExchange(context, captured);
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
  expectedGeneration?: FederationSessionGeneration,
  assertOriginal: () => void = () => undefined,
): Promise<IdentitySession> {
  assertOriginal();
  const generation = expectedGeneration ?? federationSessionGeneration();
  const sessionEpoch = identitySessionEpoch();
  if (federationSessionGeneration() !== generation)
    throw new FederationError(
      "sign_in_cancelled",
      "That sign-in was ended by a sign-out. Start again.",
    );
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
  assertOriginal();
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
  assertOriginal();
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
  // The generation was checked before the request; check it again before the
  // synchronous adoption so a sign-out during the exchange cannot be undone.
  if (federationSessionGeneration() !== generation)
    throw new FederationError(
      "sign_in_cancelled",
      "That sign-in was ended by a sign-out. Start again.",
    );
  assertOriginal();
  restoreSession(session, sessionEpoch);
  return session;
}

/** Strip the code out of the address bar so a reload cannot replay it. */
export function clearAuthResponseFromUrl(): void {
  const url = new URL(page().location.href);
  for (const key of ["code", "state", "error", "error_description", "scope"]) {
    url.searchParams.delete(key);
  }
  page().replaceUrl(url.toString());
}

function issuerIsTrusted(issuer: string): boolean {
  return Boolean(
    upstreamByIssuer(issuer) ||
      isBrokeredIssuer(issuer) ||
      isOperatorIdpIssuer(issuer),
  );
}

function loadSessionDefault(): UpstreamIdentity | null {
  const native = readNativeFederationSession();
  if (native) return native;
  const raw = readFederationSessionJson();
  if (!raw) return null;
  const identity = readStoredSessionSync(raw, issuerIsTrusted);
  if (!identity || !configuredIdentitySessionTrusted(identity)) {
    clearSessionDefault();
    return null;
  }
  return identity;
}

async function completeSignInWired(): Promise<CompletedSignIn | null> {
  const captured = captureFederationAction();
  const ambient = await ambientAuthSeams.completeIfPresent(captured.search);
  if (ambient) {
    clearAuthResponseFromUrl();
    return ambient;
  }
  return completeSignInDefault(captured);
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
  expectedGeneration?: FederationSessionGeneration,
): Promise<IdentitySession> {
  const owner = consumeBrokeredPublication(accessToken, expectedGeneration);
  return owner
    ? federationSeams.adoptBrokeredSession(
        accessToken,
        owner.generation,
        owner.assertCurrent,
      )
    : federationSeams.adoptBrokeredSession(accessToken, expectedGeneration);
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
