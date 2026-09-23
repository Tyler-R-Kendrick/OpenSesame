import {
  OriginError,
  canonicalizeOrigin,
  defaultCallbackUri,
  originClientId,
} from "@opensesame/os-domain";

export { OriginError };

export class BrowserOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserOriginError";
  }
}

/**
 * Browser-side canonical origin (ADR 0050 F1/DD3). Same function the issuer
 * uses; HTTP is allowed only on loopback. Callers always pass explicit
 * options so this module never reads `process.env` in the browser.
 */
export function canonicalizeBrowserOrigin(input: string): string {
  return canonicalizeOrigin(input, {
    allowLoopbackHttp: true,
    production: false,
  });
}

export function originProfileClientId(locationOrigin: string): string {
  return originClientId(canonicalizeBrowserOrigin(locationOrigin));
}

export function defaultOriginCallback(locationOrigin: string): string {
  return defaultCallbackUri(canonicalizeBrowserOrigin(locationOrigin));
}

/**
 * Synthetic base used only to resolve a candidate path. A value that lands on
 * any other origin was never a same-origin path, whatever the page origin is.
 */
const RETURN_TO_BASE = "https://return-to.opensesame.invalid";

/**
 * C0 controls, space, DEL and every other whitespace code point. The WHATWG
 * URL parser strips tab/newline anywhere and trims leading/trailing C0/space,
 * so `"/\t/evil.example"` would otherwise resolve as `//evil.example`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is the point
const RETURN_TO_UNSAFE_CHARS = /[\u0000-\u0020\u007f\s]/u;

/**
 * returnTo must be a same-origin relative path starting with `/`. The value is
 * resolved with the WHATWG URL parser (the same one the eventual navigation
 * uses) and must stay on the resolving origin; the normalised
 * path + query + fragment is returned.
 */
export function assertSafeReturnTo(returnTo: string): string {
  if (RETURN_TO_UNSAFE_CHARS.test(returnTo)) {
    throw new BrowserOriginError("returnTo must not contain whitespace");
  }
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) {
    throw new BrowserOriginError("returnTo must be a same-origin path");
  }
  if (returnTo.includes("://") || returnTo.includes("\\")) {
    throw new BrowserOriginError("returnTo must be a relative path");
  }
  let resolved: URL;
  try {
    resolved = new URL(returnTo, RETURN_TO_BASE);
  } catch {
    throw new BrowserOriginError("returnTo must be a same-origin path");
  }
  if (resolved.origin !== RETURN_TO_BASE) {
    throw new BrowserOriginError("returnTo must be a same-origin path");
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * A stored returnTo is re-checked on the way out: storage is shared with the
 * rest of the origin, so a value written by anything but `signIn` (or by an
 * older SDK) is dropped rather than handed to a navigation.
 */
export function safeStoredReturnTo(stored: string | null): string | null {
  if (stored === null) return null;
  try {
    return assertSafeReturnTo(stored);
  } catch {
    return null;
  }
}
