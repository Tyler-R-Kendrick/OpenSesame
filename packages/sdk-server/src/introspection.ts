import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
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
  [claim: string]: import("@opensesame/os-domain").JsonValue | undefined;
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
  if (Buffer !== undefined) {
    return Buffer.from(credentials, "utf8").toString("base64");
  }
  return btoa(credentials);
}

function isJsonValue(value: BoundaryValue): value is JsonValue {
  if (
    value === null ||
    isString(value) ||
    isBoolean(value) ||
    isNumber(value)
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

function isDeepJsonObject(value: BoundaryValue): value is JsonObject {
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

/** Introspect an opaque access token via RFC 7662 (fail-closed on errors). */
export async function introspectOpaqueAccessToken(
  token: string,
  options: IntrospectOpaqueAccessTokenOptions,
): Promise<IntrospectedAccessToken> {
  assertSecureUrl(options.introspectionEndpoint, "introspectionEndpoint");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({ token });

  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  });

  if (options.clientId !== undefined && options.clientSecret !== undefined) {
    headers.set(
      "Authorization",
      `Basic ${encodeBasicAuth(options.clientId, options.clientSecret)}`,
    );
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

  let data: BoundaryValue;
  try {
    data = await response.json();
  } catch (error) {
    throw new AuthError(
      "introspection_failed",
      "Token introspection returned invalid response",
      { cause: error },
    );
  }

  if (!isDeepJsonObject(data) || !("active" in data)) {
    throw new AuthError(
      "introspection_failed",
      "Token introspection returned invalid response",
    );
  }

  if (data.active !== true) {
    throw new AuthError("token_inactive", "Token is not active");
  }

  const scope = isString(data.scope) ? data.scope : undefined;
  if (!hasRequiredScopes(scope, options.requiredScopes ?? [])) {
    throw new AuthorizationError(
      "insufficient_scope",
      "Token missing required scopes",
    );
  }

  const result: IntrospectedAccessToken = { ...data, active: true };
  return result;
}
