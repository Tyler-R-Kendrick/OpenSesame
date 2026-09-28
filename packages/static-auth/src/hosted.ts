import {
  type SealedStorage,
  type StorageLike,
  sealedStorage,
} from "@opensesame/browser-at-rest";
import { isJsonObject, isString } from "@opensesame/os-domain";
import { createPkcePair } from "@opensesame/sdk-browser";
import { createLocalJWKSet, jwtVerify } from "jose";
import { endpoint, exactOrigin, fetchJson } from "./transport.js";

export type HostedProfile = {
  profile: "hosted_identity";
  issuer: string;
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
};

function checkedProfile(profile: HostedProfile, origin: string) {
  if (
    profile.profile !== "hosted_identity" ||
    !profile.clientId ||
    profile.clientId.length > 512
  )
    throw new Error("invalid_profile");
  const issuer = endpoint(profile.issuer);
  const redirect = endpoint(profile.redirectUri);
  if (new URL(redirect).origin !== exactOrigin(origin))
    throw new Error("invalid_redirect");
  for (const value of [
    profile.authorizationEndpoint,
    profile.tokenEndpoint,
    profile.jwksUri,
  ])
    endpoint(value, issuer);
  return { ...profile };
}

/**
 * Configuration is pinned by the RP. No discovery or callback metadata can
 * replace it. The transaction between `begin` and `complete` reaches
 * `storage` sealed under the origin's at-rest key (ADR 0149), or stays in
 * memory where the origin can keep no key.
 */
export function createHostedClient(
  config: HostedProfile,
  browser: Window = window,
  storage: StorageLike = browser.sessionStorage,
) {
  const profile = checkedProfile(config, browser.location.origin);
  const storageKey = `opensesame:static-auth:${profile.clientId}:${profile.redirectUri}`;
  const sealed = sealedStorage(storage, "static-auth");
  async function begin() {
    const pkce = await createPkcePair();
    const kept = await sealed.set(
      storageKey,
      JSON.stringify({ ...pkce, createdAt: Date.now(), profile }),
    );
    // The transaction must outlive the redirect and never rests in the
    // clear (ADR 0149): an origin that can keep no key cannot sign in.
    if (kept !== "stored") {
      sealed.remove(storageKey);
      throw new Error("storage_unavailable");
    }
    const url = new URL(profile.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: profile.clientId,
      redirect_uri: profile.redirectUri,
      response_type: "code",
      scope: "openid",
      state: pkce.state,
      nonce: pkce.nonce,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    browser.location.assign(url.href);
  }

  return {
    begin,
    complete: () => completeHosted(profile, browser, sealed, storageKey),
  };
}

async function completeHosted(
  profile: HostedProfile,
  browser: Window,
  sealed: SealedStorage,
  storageKey: string,
) {
  const callback = new URL(browser.location.href);
  if (!callback.searchParams.has("code") && !callback.searchParams.has("error"))
    return null;
  // Taken before anything is awaited: one transaction, one callback.
  const taken = sealed.take(storageKey);
  // Strip credential-bearing callback material even on a rejected response.
  browser.history.replaceState(null, "", profile.redirectUri);
  const raw = await taken;
  if (
    !raw ||
    raw.length > 8192 ||
    callback.hash ||
    `${callback.origin}${callback.pathname}` !== profile.redirectUri
  )
    throw new Error("invalid_callback");
  const pending = readTransaction(raw, profile);
  const code = callbackCode(callback, pending.state, profile.issuer);
  const tokens = await fetchJson(profile.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: profile.clientId,
      redirect_uri: profile.redirectUri,
      code_verifier: pending.codeVerifier,
    }),
  });
  if (!isString(tokens.id_token) || tokens.id_token.length > 16384)
    throw new Error("invalid_token_response");
  return verifyHostedToken(tokens.id_token, profile, pending.nonce);
}

async function verifyHostedToken(
  token: string,
  profile: HostedProfile,
  nonce: string,
) {
  const jwks = await fetchJson(profile.jwksUri);
  if (
    !Array.isArray(jwks.keys) ||
    jwks.keys.length === 0 ||
    jwks.keys.length > 16 ||
    !jwks.keys.every(isJsonObject)
  )
    throw new Error("invalid_jwks");
  const verified = await jwtVerify(
    token,
    createLocalJWKSet({ keys: jwks.keys }),
    {
      issuer: profile.issuer,
      audience: profile.clientId,
      algorithms: ["ES256", "RS256"],
      requiredClaims: ["sub", "iat", "exp", "nonce"],
      maxTokenAge: "5 minutes",
      clockTolerance: 30,
    },
  );
  const claims = verified.payload;
  if (
    claims.nonce !== nonce ||
    !claims.sub ||
    (Array.isArray(claims.aud) &&
      claims.aud.length > 1 &&
      claims.azp !== profile.clientId)
  )
    throw new Error("invalid_claims");
  if (claims.azp !== undefined && claims.azp !== profile.clientId)
    throw new Error("invalid_claims");
  return { subject: claims.sub, expiresAt: (claims.exp ?? 0) * 1000 };
}

function readTransaction(raw: string, profile: HostedProfile) {
  const pending = JSON.parse(raw);
  if (
    !isJsonObject(pending) ||
    !isString(pending.state) ||
    !isString(pending.nonce) ||
    !isString(pending.codeVerifier) ||
    JSON.stringify(pending.profile) !== JSON.stringify(profile)
  )
    throw new Error("invalid_transaction");
  if (
    !Number.isSafeInteger(pending.createdAt) ||
    !Number.isFinite(Number(pending.createdAt)) ||
    Date.now() - Number(pending.createdAt) > 300000 ||
    Date.now() < Number(pending.createdAt)
  )
    throw new Error("expired_transaction");
  return {
    state: pending.state,
    nonce: pending.nonce,
    codeVerifier: pending.codeVerifier,
  };
}

function callbackCode(callback: URL, state: string, issuer: string) {
  for (const key of ["code", "state", "iss"])
    if (callback.searchParams.getAll(key).length !== 1)
      throw new Error("invalid_callback");
  const code = callback.searchParams.get("code");
  if (
    !code ||
    code.length > 2048 ||
    callback.searchParams.has("error") ||
    callback.searchParams.get("state") !== state ||
    callback.searchParams.get("iss") !== issuer
  )
    throw new Error("invalid_callback");
  return code;
}
