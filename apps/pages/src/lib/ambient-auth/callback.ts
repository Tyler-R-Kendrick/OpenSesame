/**
 * Auth-callback parser. Correlates success and error before any record is
 * consumed. Duplicate protocol parameters and success-plus-error are refused.
 */

import { isString } from "@opensesame/os-domain";
import type { AmbientReasonCode } from "./types.js";

const AUTH_PARAM_NAMES = [
  "code",
  "state",
  "iss",
  "error",
  "error_description",
  "session_state",
] as const;

export type ParsedAuthCallback =
  | { kind: "none" }
  | { kind: "malformed"; reason: AmbientReasonCode }
  | {
      kind: "error";
      error: string;
      state: string | null;
      issuer: string | null;
      description: string | null;
    }
  | {
      kind: "success";
      code: string;
      state: string;
      issuer: string | null;
    };

const SAFE_ERROR = /^[a-z][a-z0-9_-]{0,63}$/i;

function callbackParams(search: string, hash: string): URLSearchParams {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  if (!hash.includes("=")) return params;
  const fromHash = new URLSearchParams(hash.replace(/^#/, ""));
  for (const [key, value] of fromHash) {
    if (!params.has(key)) params.append(key, value);
  }
  return params;
}

function hasDuplicateAuthParams(params: URLSearchParams): boolean {
  return (
    params.getAll("code").length > 1 ||
    params.getAll("state").length > 1 ||
    params.getAll("iss").length > 1 ||
    params.getAll("error").length > 1 ||
    (params.has("code") && params.has("error"))
  );
}

export function parseAuthCallback(
  search: string,
  hash = "",
): ParsedAuthCallback {
  const params = callbackParams(search, hash);
  const hasCode = params.has("code");
  const hasError = params.has("error");
  if (!hasCode && !hasError) return { kind: "none" };
  if (hasDuplicateAuthParams(params)) {
    return { kind: "malformed", reason: "duplicate_params" };
  }
  const state = params.get("state");
  const issuer = params.get("iss");
  if (hasError) {
    const error = params.get("error") ?? "invalid_request";
    return {
      kind: "error",
      error: SAFE_ERROR.test(error) ? error : "invalid_request",
      state,
      issuer,
      description: sanitizeDescription(params.get("error_description")),
    };
  }
  const code = params.get("code");
  if (!isString(code) || !code || code.length > 4096) {
    return { kind: "malformed", reason: "uncorrelated" };
  }
  if (!isString(state) || !state || state.length > 256) {
    return { kind: "malformed", reason: "uncorrelated" };
  }
  return { kind: "success", code, state, issuer };
}

export function isAuthCallbackSearch(search: string): boolean {
  const parsed = parseAuthCallback(search);
  return parsed.kind !== "none";
}

export function stripAuthParams(href: string): string {
  const url = new URL(href, "https://example.invalid");
  for (const name of AUTH_PARAM_NAMES) url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}

function sanitizeDescription(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.replace(/<[^>]*>/g, "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

export function assertSafeReturnTo(
  returnTo: string | undefined,
  origin: string,
  basePath: string,
): string | undefined {
  if (!returnTo) return undefined;
  if (returnTo.startsWith("//") || returnTo.includes("://")) return undefined;
  if (!returnTo.startsWith("/")) return undefined;
  if (returnTo.includes("\\") || returnTo.includes("@")) return undefined;
  const root = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  if (root && returnTo !== root && !returnTo.startsWith(`${root}/`)) {
    return undefined;
  }
  try {
    const resolved = new URL(returnTo, origin);
    if (resolved.origin !== origin) return undefined;
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return undefined;
  }
}
