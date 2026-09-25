import { FORBIDDEN_URL_PARAMS } from "@opensesame/os-domain";
import {
  AUTHENTICATOR_INVOCATION_KINDS,
  type AuthenticatorInvocationKind,
  CEREMONY_ROUTES,
  ceremonyPath,
  invokeKind,
} from "./ceremony-routes.js";

/**
 * The authenticator hand-off, `/invoke/{kind}` (ADR 0140).
 *
 * A link names a request by reference — a request id, a user code, or a
 * public HTTPS request URI — and this module turns it into the native app
 * link for that kind, plus the browser ceremony a user code can fall back to.
 * The kinds, their handle names, their app links and their fallback all come
 * from `spec/config/ceremony-routes.json`; the checks on each handle are here.
 */

export type AuthenticatorInvocation = {
  kind: AuthenticatorInvocationKind;
  /** The query name the handle arrived under (`user_code`, `request_uri`…). */
  handleName: string;
  /** The handle as handed on: a user code upper-cased, a URI normalised. */
  handle: string;
  appUrl: string;
  browserFallback: string | null;
  requestHost: string | null;
};

/** A hand-off link that must not be followed. The message is display-safe. */
export class AuthenticatorInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticatorInvocationError";
  }
}

const HANDLE = /^[A-Za-z0-9._-]+$/;

/** Case- and separator-insensitive, as `interaction-url.ts` matches it. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_\-.\s]/g, "");
}

const FORBIDDEN: ReadonlySet<string> = new Set(
  FORBIDDEN_URL_PARAMS.map(normalizeName),
);

/** Every handle name any kind reads; anything else is refused. */
const HANDLE_NAMES: ReadonlySet<string> = new Set(
  AUTHENTICATOR_INVOCATION_KINDS.flatMap((kind) => invokeKind(kind).query),
);

/** Longest accepted value per handle name. */
const HANDLE_MAX: Readonly<Record<string, number>> = {
  request_id: 128,
  user_code: 64,
};

function fail(message: string): never {
  throw new AuthenticatorInvocationError(message);
}

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) {
    fail(`Duplicate ${name} parameters are not allowed.`);
  }
  return values[0] ?? null;
}

function handle(raw: string, max: number): string {
  if (raw.length === 0 || raw.length > max || !HANDLE.test(raw)) {
    fail("The request handle is malformed or expired.");
  }
  return raw;
}

function privateIpv4(octets: readonly number[]): boolean {
  const [a = -1, b = -1] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") {
    return true;
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return (
      host.startsWith("[fc") ||
      host.startsWith("[fd") ||
      host.startsWith("[fe80:")
    );
  }
  return privateIpv4(octets);
}

function requestUri(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("The protocol request URI is malformed.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    privateHost(url.hostname)
  ) {
    fail("The protocol request URI is not a safe public HTTPS URL.");
  }
  return url;
}

/** Refuse credential material and unknown names before reading any value. */
function assertOnlyHandles(params: URLSearchParams): void {
  for (const key of params.keys()) {
    if (FORBIDDEN.has(normalizeName(key))) {
      fail("This link contains credential material and was refused.");
    }
    if (!HANDLE_NAMES.has(key)) {
      fail("This link contains an unsupported parameter.");
    }
  }
}

/** The one handle a link carries, as `[name, value]`. */
function onlyHandle(params: URLSearchParams): [string, string] {
  const supplied = [...HANDLE_NAMES]
    .map((name) => [name, single(params, name)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  const [first] = supplied;
  if (supplied.length !== 1 || first === undefined) {
    fail("This link must contain exactly one request handle.");
  }
  return [first[0], first[1]];
}

function wrongHandle(kind: AuthenticatorInvocationKind, name: string): never {
  if (kind === "mfa") fail("MFA links cannot contain a remote request URI.");
  if (name === "user_code") {
    fail("Protocol links cannot contain an MFA user code.");
  }
  return fail("Protocol links require a standard HTTPS request URI.");
}

/** The browser ceremony a handle falls back to, when the kind names one. */
function fallbackFor(
  kind: AuthenticatorInvocationKind,
  name: string,
  value: string,
): string | null {
  const route = invokeKind(kind).fallback;
  if (route === undefined) return null;
  if (!(CEREMONY_ROUTES[route].query ?? []).includes(name)) return null;
  return `${ceremonyPath(route)}?${name}=${encodeURIComponent(value)}`;
}

/**
 * Read an `/invoke/{kind}` link's query and name its hand-off.
 *
 * Throws `AuthenticatorInvocationError` for credential material, an unknown
 * or duplicated parameter, anything but exactly one handle, a handle the kind
 * does not read, a malformed handle, and a request URI that is not public
 * HTTPS.
 */
export function parseAuthenticatorInvocation(
  kind: AuthenticatorInvocationKind,
  search: string,
): AuthenticatorInvocation {
  const params = new URLSearchParams(search);
  assertOnlyHandles(params);
  const [name, raw] = onlyHandle(params);
  const spec = invokeKind(kind);
  if (!spec.query.includes(name)) wrongHandle(kind, name);

  const appUrl = (value: string) =>
    `${spec.app}?${spec.appParameter ?? name}=${encodeURIComponent(value)}`;
  if (name === "request_uri") {
    const uri = requestUri(raw);
    return {
      kind,
      handleName: name,
      handle: uri.href,
      appUrl: appUrl(uri.href),
      browserFallback: null,
      requestHost: uri.host,
    };
  }
  // A handle name with no recorded bound is refused as malformed (max 0).
  const checked = handle(raw, HANDLE_MAX[name] ?? 0);
  const value = name === "user_code" ? checked.toUpperCase() : checked;
  return {
    kind,
    handleName: name,
    handle: value,
    appUrl: appUrl(value),
    browserFallback: fallbackFor(kind, name, value),
    requestHost: null,
  };
}
