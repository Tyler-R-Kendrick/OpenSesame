/**
 * Fragment response_mode helpers for same-device Self-Issued OP responses.
 */

import { isString } from "@opensesame/os-domain";
import { refuse } from "./errors.js";
import { MAX_FRAGMENT_RESPONSE_CHARS, MAX_ID_TOKEN_CHARS } from "./limits.js";

export interface FragmentSuccessResponse {
  readonly idToken: string;
  readonly state: string | null;
}

export interface FragmentErrorResponse {
  readonly error: string;
  readonly errorDescription: string | null;
  readonly state: string | null;
}

export type FragmentResponse =
  | ({ readonly kind: "success" } & FragmentSuccessResponse)
  | ({ readonly kind: "error" } & FragmentErrorResponse);

function stripHashPrefix(fragment: string): string {
  return fragment.startsWith("#") ? fragment.slice(1) : fragment;
}

export function serializeFragmentSuccess(
  response: FragmentSuccessResponse,
): string {
  if (
    response.idToken.length === 0 ||
    response.idToken.length > MAX_ID_TOKEN_CHARS
  ) {
    refuse("limit_exceeded", "limits");
  }
  const params = new URLSearchParams();
  params.set("id_token", response.idToken);
  if (response.state !== null) params.set("state", response.state);
  const serialized = params.toString();
  if (serialized.length > MAX_FRAGMENT_RESPONSE_CHARS) {
    refuse("limit_exceeded", "limits");
  }
  return serialized;
}

export function serializeFragmentError(
  response: FragmentErrorResponse,
): string {
  if (response.error.length === 0) {
    refuse("malformed_request", "response_serialize");
  }
  const params = new URLSearchParams();
  params.set("error", response.error);
  if (response.errorDescription !== null) {
    params.set("error_description", response.errorDescription);
  }
  if (response.state !== null) params.set("state", response.state);
  const serialized = params.toString();
  if (serialized.length > MAX_FRAGMENT_RESPONSE_CHARS) {
    refuse("limit_exceeded", "limits");
  }
  return serialized;
}

export function attachFragment(redirectUri: string, fragment: string): string {
  if (redirectUri.length === 0) {
    refuse("malformed_request", "response_serialize");
  }
  const hash = fragment.startsWith("#") ? fragment : `#${fragment}`;
  const base = redirectUri.split("#")[0];
  if (base === undefined || base.length === 0) {
    refuse("malformed_request", "response_serialize");
  }
  return `${base}${hash}`;
}

export function parseFragmentResponse(input: string): FragmentResponse {
  if (input.length > MAX_FRAGMENT_RESPONSE_CHARS + 2048) {
    refuse("limit_exceeded", "limits");
  }
  let fragment = input;
  if (input.includes("://") || input.startsWith("openid:")) {
    try {
      const url = new URL(input);
      fragment = url.hash.length > 0 ? url.hash : url.search;
    } catch {
      refuse("malformed_request", "response_parse");
    }
  }
  const body = stripHashPrefix(fragment);
  if (body.startsWith("?")) refuse("malformed_request", "response_parse");
  if (body.length > MAX_FRAGMENT_RESPONSE_CHARS) {
    refuse("limit_exceeded", "limits");
  }
  const params = new URLSearchParams(body);
  const idToken = params.get("id_token");
  const error = params.get("error");
  const stateRaw = params.get("state");
  const state = stateRaw !== null && stateRaw.length > 0 ? stateRaw : null;
  if (idToken !== null && error !== null) {
    refuse("malformed_request", "response_parse");
  }
  if (isString(idToken) && idToken.length > 0) {
    if (idToken.length > MAX_ID_TOKEN_CHARS) refuse("limit_exceeded", "limits");
    if (params.getAll("id_token").length !== 1) {
      refuse("malformed_request", "response_parse");
    }
    return { kind: "success", idToken, state };
  }
  if (isString(error) && error.length > 0) {
    if (params.getAll("error").length !== 1) {
      refuse("malformed_request", "response_parse");
    }
    const description = params.get("error_description");
    return {
      kind: "error",
      error,
      errorDescription:
        description !== null && description.length > 0 ? description : null,
      state,
    };
  }
  refuse("malformed_request", "response_parse");
}
