export type AuthenticatorInvocationKind = "mfa" | "oid4vp" | "oid4vci";

export type AuthenticatorInvocation = {
  kind: AuthenticatorInvocationKind;
  appUrl: string;
  browserFallback: string | null;
  requestHost: string | null;
};

const HANDLE = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN = new Set([
  "token",
  "access_token",
  "id_token",
  "code",
  "credential_offer",
  "password",
  "secret",
]);

export class AuthenticatorLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticatorLinkError";
  }
}

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw new AuthenticatorLinkError(
      `Duplicate ${name} parameters are not allowed.`,
    );
  }
  return values[0] ?? null;
}

function handle(raw: string, max: number): string {
  if (raw.length === 0 || raw.length > max || !HANDLE.test(raw)) {
    throw new AuthenticatorLinkError(
      "The request handle is malformed or expired.",
    );
  }
  return raw;
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

function requestUri(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthenticatorLinkError("The protocol request URI is malformed.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    privateHost(url.hostname)
  ) {
    throw new AuthenticatorLinkError(
      "The protocol request URI is not a safe public HTTPS URL.",
    );
  }
  return url;
}

export function parseAuthenticatorInvocation(
  kind: AuthenticatorInvocationKind,
  search: string,
): AuthenticatorInvocation {
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (FORBIDDEN.has(key)) {
      throw new AuthenticatorLinkError(
        "This link contains credential material and was refused.",
      );
    }
    if (!new Set(["request_id", "user_code", "request_uri"]).has(key)) {
      throw new AuthenticatorLinkError(
        "This link contains an unsupported parameter.",
      );
    }
  }

  const requestId = single(params, "request_id");
  const userCode = single(params, "user_code");
  const requestUriValue = single(params, "request_uri");
  const supplied = [requestId, userCode, requestUriValue].filter(
    (value) => value !== null,
  );
  if (supplied.length !== 1) {
    throw new AuthenticatorLinkError(
      "This link must contain exactly one request handle.",
    );
  }

  if (kind === "mfa") {
    if (requestUriValue !== null) {
      throw new AuthenticatorLinkError(
        "MFA links cannot contain a remote request URI.",
      );
    }
    if (requestId !== null) {
      const value = handle(requestId, 128);
      return {
        kind,
        appUrl: `opensesame://invoke/mfa?request_id=${encodeURIComponent(value)}`,
        browserFallback: null,
        requestHost: null,
      };
    }
    const value = handle(userCode ?? "", 64).toUpperCase();
    return {
      kind,
      appUrl: `opensesame://invoke/mfa?user_code=${encodeURIComponent(value)}`,
      browserFallback: `/device?user_code=${encodeURIComponent(value)}`,
      requestHost: null,
    };
  }

  if (userCode !== null) {
    throw new AuthenticatorLinkError(
      "Protocol links cannot contain an MFA user code.",
    );
  }
  if (requestId !== null)
    throw new AuthenticatorLinkError(
      "Protocol links require a standard HTTPS request URI.",
    );

  const uri = requestUri(requestUriValue ?? "");
  const parameter = kind === "oid4vp" ? "request_uri" : "credential_offer_uri";
  const scheme = kind === "oid4vp" ? "openid4vp" : "openid-credential-offer";
  return {
    kind,
    appUrl: `${scheme}://?${parameter}=${encodeURIComponent(uri.href)}`,
    browserFallback: null,
    requestHost: uri.host,
  };
}
