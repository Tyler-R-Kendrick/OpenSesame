import {
  OriginError,
  canonicalizeOrigin,
  defaultCallbackUri,
  originClientId,
} from "@opensesame/oauth-provider/origin/canonical";

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

/** returnTo must be a same-origin relative path starting with `/`. */
export function assertSafeReturnTo(returnTo: string): string {
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) {
    throw new BrowserOriginError("returnTo must be a same-origin path");
  }
  if (returnTo.includes("://") || returnTo.includes("\\")) {
    throw new BrowserOriginError("returnTo must be a relative path");
  }
  return returnTo;
}
