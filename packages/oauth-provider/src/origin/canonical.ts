export type OriginErrorCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "userinfo_forbidden"
  | "fragment_forbidden"
  | "query_forbidden"
  | "path_forbidden"
  | "http_forbidden"
  | "host_forbidden";

export class OriginError extends Error {
  readonly code: OriginErrorCode;

  constructor(code: OriginErrorCode, message: string) {
    super(message);
    this.name = "OriginError";
    this.code = code;
  }
}

export type CanonicalizeOriginOptions = {
  allowLoopbackHttp?: boolean;
  production?: boolean;
};

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/**
 * Canonical web origin (ADR 0050 F1): HTTPS only except loopback HTTP in
 * non-production; no userinfo/path/query/fragment; lowercase host; default
 * ports stripped; non-default ports preserved and distinct.
 */
export function canonicalizeOrigin(
  input: string,
  options: CanonicalizeOriginOptions = {},
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new OriginError("invalid_url", "Origin is empty");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OriginError("invalid_url", `Not a valid URL: ${input}`);
  }

  if (url.username || url.password) {
    throw new OriginError(
      "userinfo_forbidden",
      "Origin must not include userinfo",
    );
  }
  if (url.hash) {
    throw new OriginError(
      "fragment_forbidden",
      "Origin must not include a fragment",
    );
  }
  if (url.search) {
    throw new OriginError(
      "query_forbidden",
      "Origin must not include a query string",
    );
  }
  if (url.pathname && url.pathname !== "/") {
    throw new OriginError("path_forbidden", "Origin must not include a path");
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") {
    throw new OriginError(
      "unsupported_scheme",
      `Unsupported origin scheme: ${scheme}`,
    );
  }

  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (!hostname) {
    throw new OriginError("host_forbidden", "Origin host is empty");
  }

  // `process` does not exist in browsers; sdk-browser consumes this module
  // through the ./origin/canonical subpath and always passes explicit options.
  const production =
    options.production ??
    (process !== undefined && process.env?.NODE_ENV === "production");
  const loopback = isLoopbackHost(hostname);

  if (scheme === "http") {
    if (production || !options.allowLoopbackHttp || !loopback) {
      throw new OriginError(
        "http_forbidden",
        "HTTP origins are only allowed for loopback in non-production with allowLoopbackHttp",
      );
    }
  }

  const port = url.port;
  const defaultPort =
    (scheme === "https" && port === "443") ||
    (scheme === "http" && port === "80");
  const hostOut = hostname.includes(":") ? `[${hostname}]` : hostname;
  const authority = port && !defaultPort ? `${hostOut}:${port}` : hostOut;
  return `${scheme}://${authority}`;
}

export function originClientId(canonicalOrigin: string): string {
  return `origin:${canonicalOrigin}`;
}

export function defaultCallbackUri(canonicalOrigin: string): string {
  return `${canonicalOrigin}/opensesame/callback`;
}

export function parseOriginClientId(clientId: string): string | undefined {
  if (!clientId.startsWith("origin:")) return undefined;
  return clientId.slice("origin:".length);
}
