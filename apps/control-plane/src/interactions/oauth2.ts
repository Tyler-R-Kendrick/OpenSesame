import { timingSafeEqual } from "node:crypto";
import {
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  readString,
} from "@opensesame/os-domain";
import * as client from "openid-client";
import type { AppContext } from "../context.js";
import {
  FederatedAuthError,
  type FederatedAuthStart,
  type FederatedIdentity,
  type PendingFederatedAuth,
  federatedRedirectUri,
} from "./federated.js";
import type { OAuth2ProviderDescriptor } from "./registry.js";

/**
 * The generic OAuth2 relying-party leg (ADR 0055, D2).
 *
 * Plain OAuth2 providers — GitHub is the shipped one — issue no id_token, so
 * there is no assertion to verify and nothing for `openid-client` to do: the
 * whole protocol is an authorization code, a server-side exchange, and one
 * authenticated read of a userinfo document. That read IS the assurance, which
 * is why this leg lives beside the OIDC one rather than inside it: the OIDC
 * leg's entire security argument is the signed id_token, and a module that
 * could take either path would eventually take the weaker one by accident.
 *
 * What still holds here, unchanged from the OIDC leg:
 *
 *  - PKCE S256 and a `state` compared byte-for-byte at the callback;
 *  - the token exchange is server-side, with the client secret in the POST
 *    body (`client_secret_post`) and never in a URL;
 *  - every endpoint is pinned by the provider descriptor (static operator
 *    configuration), so nothing user-supplied ever decides where we connect —
 *    BYO upstreams are OIDC-only and never reach this module.
 *
 * The subject is `String(profile[subjectField])` and the descriptor is
 * deliberate about which field that is: GitHub's `id` is numeric and immutable
 * while `login` is renameable, so binding to `login` would hand an account to
 * whoever claims a released username next.
 */

/** The single-use code, its verifier, and the redirect it was minted for. */
type CodeExchange = {
  code: string;
  verifier: string;
  redirectUri: string;
};

/** How long the token and userinfo calls may take before the leg fails. */
const UPSTREAM_TIMEOUT_MS = 5_000;

/**
 * Some providers (GitHub among them) refuse an API request that does not name
 * its caller. Constant, carries no user data.
 */
const USER_AGENT = "OpenSesame-ControlPlane";

/** This leg's half of `FederatedIdentity` — never an id_token-backed one. */
export type OAuth2Identity = FederatedIdentity & { kind: "oauth2" };

function endpointUrl(
  descriptorField: string,
  raw: string,
  issuer: string,
): URL {
  try {
    return new URL(raw);
  } catch (cause) {
    // Configuration, not user input: naming the field is what makes it fixable.
    throw new FederatedAuthError(
      "discovery_failed",
      `The sign-in provider at ${issuer} has an unusable ${descriptorField}`,
      { cause },
    );
  }
}

/**
 * Byte-equality on `state`. The pending cookie is unsigned by design
 * (`federated.ts`), so this comparison is the binding between the browser that
 * started the leg and the redirect that finishes it.
 */
function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function decodeJsonObject(body: string): JsonObject | undefined {
  try {
    const decoded = JSON.parse(body);
    return isJsonObject(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decode a token response.
 *
 * GitHub answers `application/x-www-form-urlencoded` unless the request asked
 * for JSON (T15). We always ask for JSON, and still read the form encoding: a
 * provider that ignores our `Accept` header would otherwise turn into a
 * "successful" exchange with no access token in hand.
 */
function decodeTokenBody(contentType: string, body: string): JsonObject {
  if (contentType.toLowerCase().includes("application/json")) {
    const parsed = decodeJsonObject(body);
    if (!parsed) {
      throw new FederatedAuthError(
        "exchange_failed",
        "The sign-in provider returned an unreadable token response",
      );
    }
    return parsed;
  }
  const form: JsonObject = {};
  for (const [key, value] of new URLSearchParams(body)) form[key] = value;
  return form;
}

/**
 * Exchange the code for an access token.
 *
 * Two GitHub-shaped hazards are handled here and nowhere else (T15): the
 * response encoding above, and protocol errors that arrive as HTTP **200**
 * with an `error` key in the body. A client that branched on the status alone
 * would read `incorrect_client_credentials` as a successful sign-in with no
 * token in hand.
 */
async function exchangeCode(
  provider: OAuth2ProviderDescriptor,
  input: CodeExchange,
): Promise<string> {
  const endpoint = endpointUrl(
    "token endpoint",
    provider.tokenEndpoint,
    provider.issuer,
  );
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
  });

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        // Without this GitHub answers form-encoded; with it, JSON.
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider could not be reached",
      { cause },
    );
  }

  const decoded = decodeTokenBody(
    response.headers.get("content-type") ?? "",
    await response.text(),
  );
  // Checked before the status: a 200 carrying `error` is a refusal.
  const error = readString(decoded.error);
  if (error !== undefined && error.length > 0) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider rejected this sign-in",
      { cause: new Error(error) },
    );
  }
  if (!response.ok) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider rejected this sign-in",
    );
  }
  const accessToken = readString(decoded.access_token);
  if (accessToken === undefined || accessToken.length === 0) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider returned no access token",
    );
  }
  return accessToken;
}

async function fetchProfile(
  provider: OAuth2ProviderDescriptor,
  accessToken: string,
): Promise<JsonObject> {
  const endpoint = endpointUrl(
    "userinfo endpoint",
    provider.userinfoEndpoint,
    provider.issuer,
  );
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider could not be reached",
      { cause },
    );
  }
  if (!response.ok) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider refused to describe this account",
    );
  }
  const profile = decodeJsonObject(await response.text());
  if (!profile) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider returned an unreadable profile",
    );
  }
  return profile;
}

/**
 * The stable subject, per the descriptor's `subjectField`.
 *
 * Scalars only. A structured value (`{ id: ... }`, an array of ids) is not a
 * subject, and coercing one would produce `[object Object]` — the same string
 * for every account on that provider.
 */
function readSubject(profile: JsonObject, field: string): string | undefined {
  const raw = profile[field];
  if (isString(raw)) {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  // GitHub's `id` is a JSON number; `String(4242001)` is the subject.
  if (isNumber(raw) && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function readEmail(profile: JsonObject, field: string): string | undefined {
  const raw = readString(profile[field]);
  if (raw === undefined) return undefined;
  const email = raw.trim().toLowerCase();
  return email.length > 0 ? email : undefined;
}

/**
 * Start the leg: where to send the browser, and the state to stash.
 *
 * The caller has already resolved trust (C2) — the descriptor arrives from the
 * static registry, so there is no issuer to allowlist here.
 */
export async function beginOAuth2Auth(
  ctx: AppContext,
  uid: string,
  provider: OAuth2ProviderDescriptor,
): Promise<FederatedAuthStart> {
  const authorize = endpointUrl(
    "authorization endpoint",
    provider.authorizationEndpoint,
    provider.issuer,
  );
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();

  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", provider.clientId);
  authorize.searchParams.set(
    "redirect_uri",
    federatedRedirectUri(ctx.config, uid),
  );
  authorize.searchParams.set("scope", provider.scopes);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  return {
    authorizationUrl: authorize.href,
    pending: {
      issuer: provider.issuer,
      state,
      // No id_token on this leg, so no nonce to bind one to.
      nonce: "",
      verifier,
      kind: "oauth2",
      providerId: provider.id,
    },
  };
}

/**
 * Finish the leg. `currentUrl` is the callback URL as received.
 *
 * The `redirect_uri` sent on the exchange is rebuilt from `publicUrl` and the
 * callback path rather than from `currentUrl.origin`: behind a proxy the two
 * differ, and the value must byte-match the one the authorization request
 * carried or the provider refuses the code.
 */
export async function completeOAuth2Auth(
  ctx: AppContext,
  provider: OAuth2ProviderDescriptor,
  pending: PendingFederatedAuth,
  currentUrl: URL,
): Promise<OAuth2Identity> {
  const returnedState = currentUrl.searchParams.get("state") ?? "";
  if (!statesMatch(pending.state, returnedState)) {
    throw new FederatedAuthError(
      "exchange_failed",
      "That sign-in did not match the one this browser started",
    );
  }
  const code = currentUrl.searchParams.get("code") ?? "";
  if (code.length === 0) {
    throw new FederatedAuthError(
      "exchange_failed",
      "The sign-in provider returned no authorization code",
    );
  }

  const accessToken = await exchangeCode(provider, {
    code,
    verifier: pending.verifier,
    redirectUri: new URL(currentUrl.pathname, ctx.config.publicUrl).href,
  });
  const profile = await fetchProfile(provider, accessToken);

  const subject = readSubject(profile, provider.subjectField);
  if (subject === undefined) {
    throw new FederatedAuthError(
      "missing_subject",
      "The sign-in provider did not identify the account",
    );
  }

  // GitHub's `/user` carries the public profile email, or none when the user
  // keeps it private. That is the whole of it: `/user/emails` is a different
  // scope and a different question, and this leg never asks it (T15).
  const email = readEmail(profile, provider.profileMap?.email ?? "email");
  const name = readString(profile[provider.profileMap?.name ?? "name"]);
  const verifiedField = provider.profileMap?.emailVerifiedField;
  const emailVerified =
    verifiedField === undefined ? undefined : profile[verifiedField];

  return {
    kind: "oauth2",
    issuer: provider.issuer,
    subject,
    ...(email !== undefined ? { email } : undefined),
    ...(name !== undefined ? { name } : undefined),
    ...(isBoolean(emailVerified) ? { emailVerified } : undefined),
  };
}
