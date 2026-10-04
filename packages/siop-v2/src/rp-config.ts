/**
 * What a relying party is configured with, and the checks that configuration
 * must pass before a login can start (ADR 0161). Plain `http` is only for
 * loopback development and only when the caller says so: a default that
 * accepts it would let a typo in a deployed URL ship.
 */

import { SiopRpError } from "./rp-error.js";
import type { SiopLoginStore, SiopReplayLedger } from "./rp-store.js";

export type SiopRelyingPartyConfig = {
  /** The OP's issuer: `pagesSiopIssuer(...)`, or the one the metadata named. */
  readonly issuer: string;
  /**
   * Where to send the person; defaults to the issuer (the consent route). It
   * must be on the issuer's origin and carry no query.
   */
  readonly authorizationEndpoint?: string | undefined;
  /**
   * The application id the person registered (`local_<uuid>`), used when a
   * login does not name one. Pages mints that id in the person's own vault, so
   * a relying party for many people usually passes each person's id to
   * `startLogin` instead.
   */
  readonly clientId: string;
  /** The exact, registered redirect_uri a login uses unless it names another. */
  readonly redirectUri: string;
  /**
   * Every redirect_uri `startLogin({ redirectUri })` may name, in addition to
   * `redirectUri`. Each must be registered by the person; anything else is
   * refused before a login exists.
   */
  readonly allowedRedirectUris?: readonly string[] | undefined;
  /** Accept `http://localhost`, `127.0.0.1` and `[::1]` URLs. Development only. */
  readonly allowLoopbackHttp?: boolean | undefined;
  readonly store?: SiopLoginStore | undefined;
  readonly ledger?: SiopReplayLedger | undefined;
  readonly loginTtlMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly clockSkewSeconds?: number | undefined;
  readonly maxIatAgeSeconds?: number | undefined;
  /** Milliseconds since the epoch; a test seam. */
  readonly now?: (() => number) | undefined;
  /** Cryptographically secure random bytes; a test seam. */
  readonly randomBytes?: ((length: number) => Uint8Array) | undefined;
};

/** The application ids Pages mints, and the only ones it can have registered. */
const LOCAL_CLIENT_ID = /^local_[0-9a-f-]{36}$/;

export function checkedClientId(value: string): string {
  if (!LOCAL_CLIENT_ID.test(value)) {
    throw new SiopRpError("invalid_configuration");
  }
  return value;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * https; loopback http only on request. No credentials, no fragment, and,
 * where `allowQuery` is false (an endpoint, not a callback), no query.
 */
export function checkedUrl(
  value: string,
  options: { allowLoopbackHttp: boolean; allowQuery: boolean },
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SiopRpError("invalid_configuration");
  }
  const loopbackHttp =
    options.allowLoopbackHttp &&
    url.protocol === "http:" &&
    isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new SiopRpError("invalid_configuration");
  }
  if (url.username !== "" || url.password !== "" || value.includes("#")) {
    throw new SiopRpError("invalid_configuration");
  }
  if (!options.allowQuery && value.includes("?")) {
    throw new SiopRpError("invalid_configuration");
  }
  return url;
}

/** Origin, path and query: the parts of a redirect_uri a server can see. */
export function redirectKey(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
