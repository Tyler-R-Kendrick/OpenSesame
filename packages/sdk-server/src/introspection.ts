import { AuthError, AuthorizationError } from "./errors.js";
import { hasRequiredScopes } from "./jwt-utils.js";
import { assertSecureUrl } from "./verifier.js";

export interface IntrospectedAccessToken {
  active: true;
  sub?: string;
  client_id?: string;
  scope?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  token_type?: string;
  [claim: string]: unknown;
}

export interface IntrospectOpaqueAccessTokenOptions {
  introspectionEndpoint: string;
  clientId?: string;
  clientSecret?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  requiredScopes?: string[];
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  const credentials = `${clientId}:${clientSecret}`;
  if (typeof Buffer !== "undefined") {
    return Buffer.from(credentials, "utf8").toString("base64");
  }
  return btoa(credentials);
}

/** Introspect an opaque access token via RFC 7662 (fail-closed on errors). */
export async function introspectOpaqueAccessToken(
  token: string,
  options: IntrospectOpaqueAccessTokenOptions,
): Promise<IntrospectedAccessToken> {
  assertSecureUrl(options.introspectionEndpoint, "introspectionEndpoint");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({ token });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (options.clientId !== undefined && options.clientSecret !== undefined) {
    headers.Authorization = `Basic ${encodeBasicAuth(options.clientId, options.clientSecret)}`;
  } else if (options.clientId !== undefined) {
    body.set("client_id", options.clientId);
  }

  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      headers,
      body,
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }
    response = await fetchFn(options.introspectionEndpoint, init);
  } catch (error) {
    throw new AuthError(
      "introspection_failed",
      "Token introspection request failed",
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new AuthError(
      "introspection_failed",
      "Token introspection request failed",
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new AuthError(
      "introspection_failed",
      "Token introspection returned invalid response",
      { cause: error },
    );
  }

  if (typeof data !== "object" || data === null || !("active" in data)) {
    throw new AuthError(
      "introspection_failed",
      "Token introspection returned invalid response",
    );
  }

  const record = data as Record<string, unknown>;
  if (record.active !== true) {
    throw new AuthError("token_inactive", "Token is not active");
  }

  const scope = typeof record.scope === "string" ? record.scope : undefined;
  if (!hasRequiredScopes(scope, options.requiredScopes ?? [])) {
    throw new AuthorizationError(
      "insufficient_scope",
      "Token missing required scopes",
    );
  }

  return { ...record, active: true as const };
}
