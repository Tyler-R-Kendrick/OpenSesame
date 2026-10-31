/**
 * What the bridge will send, decided from the request alone (ADR 0199): HTTPS to
 * a host the table names for the provider the page says it is calling, which a
 * person has allowed, with headers a browser would let a page set and a body of
 * bounded size. A request that is not exactly that is refused, never repaired.
 */
import {
  type BridgeErrorCode,
  type BridgeFetchRequest,
  type HeaderPair,
  MAX_HEADERS,
  MAX_HEADER_VALUE,
  MAX_REQUEST_BODY,
} from "./protocol.js";

export type BridgeRow = {
  readonly providerId: string;
  /** Hosts of the provider's API-key check. */
  readonly authorities: readonly string[];
  /** Hosts of a registered OAuth application's token, resource and revocation endpoints (ADR 0218). */
  readonly oauth?: readonly string[];
  /** `*.suffix` families a person's own tenant may live at: a host is named only if it is one of these. */
  readonly tenants?: readonly string[];
};
export type BridgeTable = readonly BridgeRow[];

export type Verdict =
  | { ok: true; url: URL; headers: HeaderPair[] }
  | { ok: false; code: BridgeErrorCode };

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A control character in a header value would split the request. */
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
/** Names a browser's own fetch refuses a page: the bridge refuses them too, so nothing looks set that is not. */
const FORBIDDEN = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
]);

/** The API-key hosts of a provider. */
export function authoritiesOf(
  table: BridgeTable,
  providerId: string,
): readonly string[] {
  return table.find((row) => row.providerId === providerId)?.authorities ?? [];
}

/** The literal hosts of a provider's registered OAuth application. */
export function oauthAuthoritiesOf(
  table: BridgeTable,
  providerId: string,
): readonly string[] {
  return table.find((row) => row.providerId === providerId)?.oauth ?? [];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether `host` is a tenant under a `*.suffix` family: at least one label in
 * front of the suffix, each a plain DNS label. `evilokta.com` and
 * `okta.com.evil.test` are not under `*.okta.com`, and neither is `okta.com`.
 */
export function underTenantFamily(host: string, pattern: string): boolean {
  if (!pattern.startsWith("*.")) return false;
  const suffix = pattern.slice(1);
  if (!host.endsWith(suffix) || host.length <= suffix.length) return false;
  return host
    .slice(0, host.length - suffix.length)
    .split(".")
    .every((label) => LABEL.test(label));
}

function rowAllows(row: BridgeRow, host: string): boolean {
  return (
    row.authorities.includes(host) ||
    (row.oauth?.includes(host) ?? false) ||
    (row.tenants?.some((pattern) => underTenantFamily(host, pattern)) ?? false)
  );
}

/** Whether the table lets this provider be called at this host. */
export function providerAllowsHost(
  table: BridgeTable,
  providerId: string,
  host: string,
): boolean {
  return table.some(
    (row) => row.providerId === providerId && rowAllows(row, host),
  );
}

/** The provider the table gives this host to, if any. */
export function providerOfHost(
  table: BridgeTable,
  host: string,
): string | null {
  return table.find((row) => rowAllows(row, host))?.providerId ?? null;
}

/** Every provider the table lets be called at this host. */
export function providersOfHost(table: BridgeTable, host: string): string[] {
  return table
    .filter((row) => rowAllows(row, host))
    .map((row) => row.providerId);
}

/** Whether the table names this host at all: what an extension may ever be asked to allow. */
export function isNamedHost(table: BridgeTable, host: string): boolean {
  return providerOfHost(table, host) !== null;
}

/** Every literal host the table names, once. A tenant family names no host until a person does. */
export function allAuthorities(table: BridgeTable): string[] {
  return [
    ...new Set(
      table.flatMap((row) => [...row.authorities, ...(row.oauth ?? [])]),
    ),
  ].sort();
}

function cleanHeaders(
  headers: readonly HeaderPair[],
): HeaderPair[] | "denied_header" | "bad_request" {
  if (headers.length > MAX_HEADERS) return "bad_request";
  const out: HeaderPair[] = [];
  const seen = new Set<string>();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (
      !TOKEN.test(name) ||
      hasControl(value) ||
      value.length > MAX_HEADER_VALUE
    )
      return "bad_request";
    if (
      FORBIDDEN.has(lower) ||
      lower.startsWith("proxy-") ||
      lower.startsWith("sec-")
    )
      return "denied_header";
    if (seen.has(lower)) return "bad_request";
    seen.add(lower);
    out.push([lower, value]);
  }
  return out;
}

/** The address: HTTPS, no port, credentials or fragment, a host this provider is allowed and a person has allowed. */
function checkAddress(
  request: BridgeFetchRequest,
  table: BridgeTable,
  granted: ReadonlySet<string>,
): { url: URL } | { code: BridgeErrorCode } {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { code: "bad_request" };
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    return { code: "bad_request" };
  if (!providerAllowsHost(table, request.providerId, url.hostname))
    return { code: "host_not_allowed" };
  if (!granted.has(url.hostname)) return { code: "not_granted" };
  return { url };
}

/** A body only where the method carries one, and no larger than the bridge sends. */
function checkBody(request: BridgeFetchRequest): BridgeErrorCode | null {
  if (request.body === null) return null;
  if (request.method === "GET" || request.method === "HEAD")
    return "bad_request";
  const size = new TextEncoder().encode(request.body).length;
  return size > MAX_REQUEST_BODY ? "too_large" : null;
}

/** Whether a request may be sent, to what, and with which headers. */
export function checkFetch(
  request: BridgeFetchRequest,
  table: BridgeTable,
  granted: ReadonlySet<string>,
): Verdict {
  const address = checkAddress(request, table, granted);
  if ("code" in address) return { ok: false, code: address.code };
  const refused = checkBody(request);
  if (refused) return { ok: false, code: refused };
  const headers = cleanHeaders(request.headers);
  if (headers === "denied_header" || headers === "bad_request")
    return { ok: false, code: headers };
  return { ok: true, url: address.url, headers };
}

/** The response headers a page may see: everything but cookies, bounded. */
export function responseHeaders(headers: Headers): HeaderPair[] {
  const out: HeaderPair[] = [];
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower === "set-cookie2") return;
    if (out.length < MAX_HEADERS && value.length <= MAX_HEADER_VALUE)
      out.push([lower, value]);
  });
  return out;
}
