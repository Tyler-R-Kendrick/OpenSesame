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
import { hasRequiredScopes, readJwtAudience } from "./jwt-utils.js";
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
  /**
   * The audience (resource identifier) this server accepts. Required: an
   * authorization server reports any live token as `active`, including one
   * minted for a different resource, so an active token whose `aud` does not
   * name one of these is refused. Several values accept any one of them.
   */
  audience: string | readonly string[];
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

function expectedAudiences(audience: string | readonly string[]): string[] {
  const list = new Array<string>()
    .concat(audience)
    .filter((entry) => isString(entry) && entry.length > 0);
  if (list.length === 0) {
    throw new Error("introspection audience must not be empty");
  }
  return list;
}

/** RFC 7662 `aud`: a string or an array of strings, one of which must match. */
function audienceMatches(value: BoundaryValue, expected: string[]): boolean {
  const aud = readJwtAudience(value);
  if (aud === undefined) return false;
  return new Array<string>()
    .concat(aud)
    .some((entry) => expected.includes(entry));
}

/**
 * The RFC 7662 request. Redirects are refused: following one would carry the
 * token (and possibly the client credentials) to wherever it pointed.
 */
function introspectionRequest(
  token: string,
  options: IntrospectOpaqueAccessTokenOptions,
): RequestInit {
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

  const init: RequestInit = {
    method: "POST",
    headers,
    body,
    redirect: "error",
  };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  return init;
}

/** Introspect an opaque access token via RFC 7662 (fail-closed on errors). */
export async function introspectOpaqueAccessToken(
  token: string,
  options: IntrospectOpaqueAccessTokenOptions,
): Promise<IntrospectedAccessToken> {
  assertSecureUrl(options.introspectionEndpoint, "introspectionEndpoint");
  const audiences = expectedAudiences(options.audience);
  const fetchFn = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchFn(
      options.introspectionEndpoint,
      introspectionRequest(token, options),
    );
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

  if (!audienceMatches(data.aud ?? null, audiences)) {
    throw new AuthError("invalid_audience", "Token audience is invalid");
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
