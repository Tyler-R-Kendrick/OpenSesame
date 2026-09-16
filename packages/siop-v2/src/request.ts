/**
 * Strict Self-Issued OP authentication-request parse and normalize.
 */

import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { refuse } from "./errors.js";
import { MAX_AUTH_REQUEST_CHARS } from "./limits.js";

export const RESPONSE_TYPE_ID_TOKEN = "id_token" as const;
export const SCOPE_OPENID = "openid" as const;
export const RESPONSE_MODE_FRAGMENT = "fragment" as const;

export type SupportedResponseMode = typeof RESPONSE_MODE_FRAGMENT;

export interface NormalizedAuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly nonce: string;
  readonly scope: typeof SCOPE_OPENID;
  readonly responseType: typeof RESPONSE_TYPE_ID_TOKEN;
  readonly responseMode: SupportedResponseMode;
  readonly state: string | null;
}

export type AuthorizationRequestInput =
  | string
  | URLSearchParams
  | Record<string, string | readonly string[] | undefined>;

function requireSingle(params: URLSearchParams, name: string): string {
  const all = params.getAll(name);
  if (all.length !== 1) refuse("malformed_request", "request_normalize");
  const value = all[0];
  if (value === undefined || value.length === 0) {
    refuse("malformed_request", "request_normalize");
  }
  return value;
}

function isAuthRequestQueryString(
  input: AuthorizationRequestInput,
): input is string {
  return (
    !(input instanceof URLSearchParams) &&
    isString(overlapCast<AuthorizationRequestInput, BoundaryValue>(input))
  );
}

function isQueryParamString(
  raw: string | readonly string[] | undefined,
): raw is string {
  return isString(
    overlapCast<string | readonly string[] | undefined, BoundaryValue>(raw),
  );
}

function optionalSingle(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  if (all.length === 0) return null;
  if (all.length !== 1) refuse("malformed_request", "request_normalize");
  const value = all[0];
  if (value === undefined || value.length === 0) {
    refuse("malformed_request", "request_normalize");
  }
  return value;
}

function toSearchParams(input: AuthorizationRequestInput): URLSearchParams {
  if (input instanceof URLSearchParams) {
    if (input.toString().length > MAX_AUTH_REQUEST_CHARS) {
      refuse("limit_exceeded", "limits");
    }
    return new URLSearchParams(input);
  }
  if (isAuthRequestQueryString(input)) {
    if (input.length > MAX_AUTH_REQUEST_CHARS)
      refuse("limit_exceeded", "limits");
    const trimmed = input.startsWith("?") ? input.slice(1) : input;
    if (trimmed.includes("://") || trimmed.startsWith("openid:")) {
      try {
        const url = new URL(trimmed);
        if (url.search.length > MAX_AUTH_REQUEST_CHARS) {
          refuse("limit_exceeded", "limits");
        }
        return new URLSearchParams(url.searchParams);
      } catch {
        refuse("malformed_request", "request_parse");
      }
    }
    return new URLSearchParams(trimmed);
  }
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    if (isQueryParamString(raw)) {
      params.append(key, raw);
      continue;
    }
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (!isQueryParamString(entry)) {
          refuse("malformed_request", "request_parse");
        }
        params.append(key, entry);
      }
      continue;
    }
    refuse("malformed_request", "request_parse");
  }
  if (params.toString().length > MAX_AUTH_REQUEST_CHARS) {
    refuse("limit_exceeded", "limits");
  }
  return params;
}

export function parseAuthorizationRequest(
  input: AuthorizationRequestInput,
): NormalizedAuthorizationRequest {
  const params = toSearchParams(input);
  const clientId = requireSingle(params, "client_id");
  const redirectUri = requireSingle(params, "redirect_uri");
  const nonce = requireSingle(params, "nonce");
  const scope = requireSingle(params, "scope");
  const responseType = requireSingle(params, "response_type");
  if (scope !== SCOPE_OPENID) refuse("malformed_request", "request_normalize");
  if (responseType !== RESPONSE_TYPE_ID_TOKEN) {
    refuse("malformed_request", "request_normalize");
  }
  const responseModeRaw = optionalSingle(params, "response_mode");
  if (responseModeRaw !== null && responseModeRaw !== RESPONSE_MODE_FRAGMENT) {
    refuse("not_supported", "request_normalize");
  }
  if (
    params.has("request") ||
    params.has("request_uri") ||
    params.has("registration") ||
    params.has("registration_uri")
  ) {
    refuse("not_supported", "request_normalize");
  }
  return {
    clientId,
    redirectUri,
    nonce,
    scope: SCOPE_OPENID,
    responseType: RESPONSE_TYPE_ID_TOKEN,
    responseMode: RESPONSE_MODE_FRAGMENT,
    state: optionalSingle(params, "state"),
  };
}

export function serializeAuthorizationRequest(
  request: NormalizedAuthorizationRequest,
): string {
  const params = new URLSearchParams();
  params.set("response_type", request.responseType);
  params.set("client_id", request.clientId);
  params.set("redirect_uri", request.redirectUri);
  params.set("scope", request.scope);
  params.set("nonce", request.nonce);
  params.set("response_mode", request.responseMode);
  if (request.state !== null) params.set("state", request.state);
  const serialized = params.toString();
  if (serialized.length > MAX_AUTH_REQUEST_CHARS) {
    refuse("limit_exceeded", "limits");
  }
  return serialized;
}
