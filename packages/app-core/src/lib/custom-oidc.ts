/** Generic browser authorization-code + PKCE for an operator-supplied OIDC client. */
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { type JSONWebKeySet, createLocalJWKSet, jwtVerify } from "jose";

export type OidcTokenAuth =
  | "none"
  | "client_secret_post"
  | "client_secret_basic";

export type OidcConnectorConfig = {
  name: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  deviceAuthorizationEndpoint?: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  /** Optional endpoint that performs the token exchange with the client secret. */
  tokenRelayUrl: string;
  scopes: string[];
  tokenAuth: OidcTokenAuth;
};

export type OidcPending = {
  state: string;
  nonce: string;
  codeVerifier: string;
  config: OidcConnectorConfig;
};

export type OidcDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalSeconds: number;
};

export type OidcTokens = {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType: string;
};

/** What an issuer's discovery document says about its endpoints. */
export type OidcDiscovery = Omit<
  OidcConnectorConfig,
  | "name"
  | "clientId"
  | "clientSecret"
  | "callbackUrl"
  | "tokenRelayUrl"
  | "scopes"
  | "tokenAuth"
>;

/** The login's authorization URL, and what its callback is checked against. */
export type OidcLoginStart = { url: string; pending: OidcPending };

/** How a token request is sent, and the keys an ID token is checked with. */
export type OidcTokenOptions = {
  fetchImpl?: typeof fetch;
  jwks?: JSONWebKeySet;
};

/** A JSON object body, or an empty object when the body is anything else. */
async function jsonBody(response: Response): Promise<JsonObject> {
  const parsed: JsonValue = await response.json();
  return isJsonObject(parsed) ? parsed : {};
}

/** A token endpoint's answer, read; null when it carries no access token. */
function readTokens(json: JsonObject): OidcTokens | null {
  const accessToken = json.access_token;
  const tokenType = json.token_type;
  if (!isString(accessToken) || !isString(tokenType)) return null;
  const tokens: OidcTokens = { accessToken, tokenType };
  if (isString(json.id_token)) tokens.idToken = json.id_token;
  if (isString(json.refresh_token)) tokens.refreshToken = json.refresh_token;
  if (isNumber(json.expires_in))
    tokens.expiresAt = new Date(
      Date.now() + json.expires_in * 1000,
    ).toISOString();
  return tokens;
}

function secure(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(
      `${what} must be an HTTPS URL without credentials or fragment`,
    );
  return url.href;
}

export async function discoverOidc(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcDiscovery> {
  const base = secure(issuer, "Issuer").replace(/\/+$/u, "");
  const response = await fetchImpl(`${base}/.well-known/openid-configuration`, {
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error(`OIDC discovery failed (${response.status})`);
  const doc = await jsonBody(response);
  if (doc.issuer !== base)
    throw new Error(
      "OIDC discovery issuer does not match the configured issuer",
    );
  const authorization = doc.authorization_endpoint;
  const token = doc.token_endpoint;
  const jwks = doc.jwks_uri;
  if (!isString(authorization) || !isString(token) || !isString(jwks))
    throw new Error("OIDC discovery is missing an endpoint");
  const discovered: OidcDiscovery = {
    issuer: base,
    authorizationEndpoint: secure(authorization, "Authorization endpoint"),
    tokenEndpoint: secure(token, "Token endpoint"),
    jwksUri: secure(jwks, "JWKS URI"),
  };
  const device = doc.device_authorization_endpoint;
  if (isString(device))
    discovered.deviceAuthorizationEndpoint = secure(
      device,
      "Device authorization endpoint",
    );
  return discovered;
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

type Pkce = { verifier: string; challenge: string };

async function pkce(): Promise<Pkce> {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: b64(new Uint8Array(digest)) };
}

export async function beginOidcLogin(
  config: OidcConnectorConfig,
): Promise<OidcLoginStart> {
  const { verifier, challenge } = await pkce();
  const state = b64(crypto.getRandomValues(new Uint8Array(16)));
  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(
    secure(config.authorizationEndpoint, "Authorization endpoint"),
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return {
    url: url.href,
    pending: { state, nonce, codeVerifier: verifier, config },
  };
}

function callbackCode(callbackUrl: string, expectedState: string): string {
  const url = new URL(callbackUrl);
  if (url.searchParams.get("state") !== expectedState)
    throw new Error("OIDC callback state does not match");
  const error = url.searchParams.get("error");
  if (error) throw new Error(`OIDC authorization failed: ${error}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OIDC callback has no authorization code");
  return code;
}

async function verifyOidcIdToken(
  config: OidcConnectorConfig,
  idToken: string,
  nonce: string | undefined,
  options: OidcTokenOptions,
): Promise<void> {
  const jwks = options.jwks
    ? createLocalJWKSet(options.jwks)
    : (await import("jose")).createRemoteJWKSet(
        new URL(secure(config.jwksUri, "JWKS URI")),
      );
  const verified = await jwtVerify(idToken, jwks, {
    issuer: config.issuer,
    audience: config.clientId,
  });
  if (nonce !== undefined && verified.payload.nonce !== nonce)
    throw new Error("OIDC ID token nonce does not match");
}

function tokenExchangeUrl(config: OidcConnectorConfig): string {
  return config.tokenRelayUrl.trim() !== ""
    ? secure(config.tokenRelayUrl, "Token relay URL")
    : secure(config.tokenEndpoint, "Token endpoint");
}

const FORM = "application/x-www-form-urlencoded";

function tokenRequestBody(
  config: OidcConnectorConfig,
  body: URLSearchParams,
  headers: Headers,
): void {
  if (config.tokenRelayUrl.trim() !== "") return;
  if (config.tokenAuth === "client_secret_post")
    body.set("client_secret", config.clientSecret);
  if (config.tokenAuth === "client_secret_basic") {
    headers.set(
      "authorization",
      `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
    );
    body.delete("client_id");
  }
}

export async function completeOidcLogin(
  pending: OidcPending,
  callbackUrl: string,
  options: OidcTokenOptions = {},
): Promise<OidcTokens> {
  const config = pending.config;
  const code = callbackCode(callbackUrl, pending.state);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    client_id: config.clientId,
    code_verifier: pending.codeVerifier,
  });
  const headers = new Headers({ "content-type": FORM });
  tokenRequestBody(config, body, headers);
  const response = await (options.fetchImpl ?? fetch)(
    tokenExchangeUrl(config),
    {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers,
      body,
    },
  );
  if (!response.ok)
    throw new Error(`OIDC token exchange failed (${response.status})`);
  const tokens = readTokens(await jsonBody(response));
  if (!tokens) throw new Error("OIDC token response is invalid");
  if (tokens.idToken !== undefined)
    await verifyOidcIdToken(config, tokens.idToken, pending.nonce, options);
  return tokens;
}

export async function beginOidcDevice(
  config: OidcConnectorConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcDeviceAuthorization> {
  if (!config.deviceAuthorizationEndpoint)
    throw new Error("This issuer does not advertise device authorization");
  const body = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scopes.join(" "),
  });
  const headers = new Headers({ "content-type": FORM });
  const response = await fetchImpl(
    secure(config.deviceAuthorizationEndpoint, "Device authorization endpoint"),
    { method: "POST", redirect: "error", credentials: "omit", headers, body },
  );
  if (!response.ok)
    throw new Error(`OIDC device authorization failed (${response.status})`);
  const json = await jsonBody(response);
  const { device_code: deviceCode, user_code: userCode } = json;
  const { verification_uri: uri, expires_in: expiresIn, interval } = json;
  if (
    !isString(deviceCode) ||
    !isString(userCode) ||
    !isString(uri) ||
    !isNumber(expiresIn)
  )
    throw new Error("OIDC device authorization response is invalid");
  const authorization: OidcDeviceAuthorization = {
    deviceCode,
    userCode,
    verificationUri: secure(uri, "Verification URI"),
    expiresAt: Date.now() + expiresIn * 1000,
    intervalSeconds:
      isNumber(interval) && interval > 0 ? Math.min(interval, 60) : 5,
  };
  const complete = json.verification_uri_complete;
  if (isString(complete))
    authorization.verificationUriComplete = secure(
      complete,
      "Verification URI complete",
    );
  return authorization;
}

export type OidcDevicePoll =
  | { status: "pending"; intervalSeconds: number }
  | { status: "tokens"; tokens: OidcTokens };

export async function pollOidcDevice(
  config: OidcConnectorConfig,
  authorization: OidcDeviceAuthorization,
  options: OidcTokenOptions = {},
): Promise<OidcDevicePoll> {
  if (Date.now() >= authorization.expiresAt)
    throw new Error("OIDC device code expired");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: authorization.deviceCode,
    client_id: config.clientId,
  });
  const headers = new Headers({ "content-type": FORM });
  tokenRequestBody(config, body, headers);
  const response = await (options.fetchImpl ?? fetch)(
    tokenExchangeUrl(config),
    {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers,
      body,
    },
  );
  const json = await jsonBody(response);
  if (json.error === "authorization_pending")
    return {
      status: "pending",
      intervalSeconds: authorization.intervalSeconds,
    };
  if (json.error === "slow_down")
    return {
      status: "pending",
      intervalSeconds: Math.min(authorization.intervalSeconds + 5, 60),
    };
  const tokens = response.ok ? readTokens(json) : null;
  if (!tokens)
    throw new Error(
      isString(json.error)
        ? `OIDC device authorization failed: ${json.error}`
        : "OIDC device token response is invalid",
    );
  if (tokens.idToken !== undefined)
    await verifyOidcIdToken(config, tokens.idToken, undefined, options);
  return { status: "tokens", tokens };
}

/** The configuration and tokens are one sealed vault item, never local storage. */
export function oidcConnectorItem(
  config: OidcConnectorConfig,
  tokens?: OidcTokens,
) {
  const item = createItem("secret", config.name);
  return {
    ...item,
    value: JSON.stringify({ ...config, tokens: tokens ?? null }),
    fields: [
      { id: "issuer", name: "Issuer", value: config.issuer, hidden: false },
      {
        id: "client_id",
        name: "Client ID",
        value: config.clientId,
        hidden: false,
      },
      {
        id: "callback",
        name: "Callback URL",
        value: config.callbackUrl,
        hidden: false,
      },
    ],
  };
}
