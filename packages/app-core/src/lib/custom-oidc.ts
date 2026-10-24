/** Generic browser authorization-code + PKCE for an operator-supplied OIDC client. */
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
): Promise<
  Omit<
    OidcConnectorConfig,
    | "name"
    | "clientId"
    | "clientSecret"
    | "callbackUrl"
    | "tokenRelayUrl"
    | "scopes"
    | "tokenAuth"
  >
> {
  const base = secure(issuer, "Issuer").replace(/\/+$/u, "");
  const response = await fetchImpl(`${base}/.well-known/openid-configuration`, {
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error(`OIDC discovery failed (${response.status})`);
  const doc = (await response.json()) as Record<string, unknown>;
  if (doc.issuer !== base)
    throw new Error(
      "OIDC discovery issuer does not match the configured issuer",
    );
  if (
    typeof doc.authorization_endpoint !== "string" ||
    typeof doc.token_endpoint !== "string" ||
    typeof doc.jwks_uri !== "string"
  )
    throw new Error("OIDC discovery is missing an endpoint");
  return {
    issuer: base,
    authorizationEndpoint: secure(
      doc.authorization_endpoint,
      "Authorization endpoint",
    ),
    tokenEndpoint: secure(doc.token_endpoint, "Token endpoint"),
    jwksUri: secure(doc.jwks_uri, "JWKS URI"),
    ...(typeof doc.device_authorization_endpoint === "string"
      ? {
          deviceAuthorizationEndpoint: secure(
            doc.device_authorization_endpoint,
            "Device authorization endpoint",
          ),
        }
      : {}),
  };
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: b64(new Uint8Array(digest)) };
}

export async function beginOidcLogin(
  config: OidcConnectorConfig,
): Promise<{ url: string; pending: OidcPending }> {
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
  options: { fetchImpl?: typeof fetch; jwks?: JSONWebKeySet },
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

function tokenRequestBody(
  config: OidcConnectorConfig,
  body: URLSearchParams,
  headers: Record<string, string>,
): void {
  if (config.tokenRelayUrl.trim() !== "") return;
  if (config.tokenAuth === "client_secret_post")
    body.set("client_secret", config.clientSecret);
  if (config.tokenAuth === "client_secret_basic") {
    headers.authorization = `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
    body.delete("client_id");
  }
}

export async function completeOidcLogin(
  pending: OidcPending,
  callbackUrl: string,
  options: { fetchImpl?: typeof fetch; jwks?: JSONWebKeySet } = {},
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
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
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
  const json = (await response.json()) as Record<string, unknown>;
  if (
    typeof json.access_token !== "string" ||
    typeof json.token_type !== "string"
  )
    throw new Error("OIDC token response is invalid");
  if (typeof json.id_token === "string")
    await verifyOidcIdToken(config, json.id_token, pending.nonce, options);
  const expiresAt =
    typeof json.expires_in === "number"
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : undefined;
  return {
    accessToken: json.access_token,
    ...(typeof json.id_token === "string" ? { idToken: json.id_token } : {}),
    ...(typeof json.refresh_token === "string"
      ? { refreshToken: json.refresh_token }
      : {}),
    ...(expiresAt ? { expiresAt } : {}),
    tokenType: json.token_type,
  };
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
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  const response = await fetchImpl(
    secure(config.deviceAuthorizationEndpoint, "Device authorization endpoint"),
    { method: "POST", redirect: "error", credentials: "omit", headers, body },
  );
  if (!response.ok)
    throw new Error(`OIDC device authorization failed (${response.status})`);
  const json = (await response.json()) as Record<string, unknown>;
  if (
    typeof json.device_code !== "string" ||
    typeof json.user_code !== "string" ||
    typeof json.verification_uri !== "string" ||
    typeof json.expires_in !== "number"
  )
    throw new Error("OIDC device authorization response is invalid");
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: secure(json.verification_uri, "Verification URI"),
    ...(typeof json.verification_uri_complete === "string"
      ? {
          verificationUriComplete: secure(
            json.verification_uri_complete,
            "Verification URI complete",
          ),
        }
      : {}),
    expiresAt: Date.now() + json.expires_in * 1000,
    intervalSeconds:
      typeof json.interval === "number" && json.interval > 0
        ? Math.min(json.interval, 60)
        : 5,
  };
}

export type OidcDevicePoll =
  | { status: "pending"; intervalSeconds: number }
  | { status: "tokens"; tokens: OidcTokens };

export async function pollOidcDevice(
  config: OidcConnectorConfig,
  authorization: OidcDeviceAuthorization,
  options: { fetchImpl?: typeof fetch; jwks?: JSONWebKeySet } = {},
): Promise<OidcDevicePoll> {
  if (Date.now() >= authorization.expiresAt)
    throw new Error("OIDC device code expired");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: authorization.deviceCode,
    client_id: config.clientId,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
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
  const json = (await response.json()) as Record<string, unknown>;
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
  if (
    !response.ok ||
    typeof json.access_token !== "string" ||
    typeof json.token_type !== "string"
  )
    throw new Error(
      typeof json.error === "string"
        ? `OIDC device authorization failed: ${json.error}`
        : "OIDC device token response is invalid",
    );
  if (typeof json.id_token === "string")
    await verifyOidcIdToken(config, json.id_token, undefined, options);
  return {
    status: "tokens",
    tokens: {
      accessToken: json.access_token,
      ...(typeof json.id_token === "string" ? { idToken: json.id_token } : {}),
      ...(typeof json.refresh_token === "string"
        ? { refreshToken: json.refresh_token }
        : {}),
      ...(typeof json.expires_in === "number"
        ? {
            expiresAt: new Date(
              Date.now() + json.expires_in * 1000,
            ).toISOString(),
          }
        : {}),
      tokenType: json.token_type,
    },
  };
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
