import { overlapCast } from "@opensesame/os-domain";
import type * as client from "openid-client";
import type { ControlPlaneConfig } from "../config.js";
import { guardedLibraryFetch } from "../services/guarded-fetch.js";

/** Our own public origin — what an origin-profile client id encodes. */
export function siteOrigin(config: ControlPlaneConfig): string {
  return new URL(config.publicUrl).origin;
}

/** The two facts about a client mode that decide how its requests travel. */
export type UpstreamFetchMode = { originProfile: boolean; fenced?: true };

/**
 * A broker validating an origin-profile client checks the `Origin` header
 * byte-equals the origin encoded in the client id (see
 * `apps/mock-upstream-idp/src/server.ts`, which answers `origin_cors_denied`
 * otherwise). A browser sets that header itself; a server-side exchange must
 * set it explicitly, and it must be our real public origin — the same value
 * already baked into the client id, so this asserts nothing new.
 *
 * A fenced mode (a BYO record or an organization's issuer, which anyone can
 * create or an org owner can point anywhere) routes every request openid-client
 * makes — discovery, token, revocation — through `guardedFetch`: the name is
 * resolved, private answers are refused and the socket is pinned (T21).
 */
export function upstreamFetch(
  config: ControlPlaneConfig,
  mode: UpstreamFetchMode,
): client.CustomFetch {
  const pin = mode.originProfile ? { Origin: siteOrigin(config) } : {};
  if (mode.fenced) return guardedLibraryFetch(!config.allowDevDefaults, pin);
  return (url, options) => {
    // SAFETY: CustomFetchOptions is the fetch init shape openid-client already
    // built (method/headers/body/signal); only the Origin header is added.
    const init: RequestInit = overlapCast({
      ...options,
      headers: { ...options.headers, ...pin },
    });
    return fetch(url, init);
  };
}
