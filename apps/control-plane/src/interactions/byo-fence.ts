import type { AppContext } from "../context.js";
import {
  type GuardedFetchInit,
  UnsafeUpstreamError,
  assertPublicUpstreamUrl,
  guardedFetch,
} from "../services/guarded-fetch.js";

/**
 * The network fence for bring-your-own upstreams (D5), split out of `./byo.ts`
 * so the registration flow and the rules about what it may dereference read
 * separately. Every URL a visitor typed — or a discovery document they
 * control named — goes through `upstreamFetch`.
 */

/** Refusals a visitor can cause. Everything else throws. */
export type ByoRegistrationErrorCode =
  | "invalid_issuer"
  | "discovery_failed"
  | "registration_unsupported"
  | "rate_limited";

/**
 * One message for "no such issuer", "that host is not reachable from here"
 * and "that URL is not https". A visitor typing their own issuer needs to know
 * the URL was refused; nobody needs to know which rule refused it.
 */
export const INVALID_ISSUER_MESSAGE =
  "That issuer URL cannot be used for sign-in from this server.";

/** Internal control flow; every instance becomes a result-shaped refusal. */
export class ByoRegistrationError extends Error {
  override readonly name = "ByoRegistrationError";
  readonly code: ByoRegistrationErrorCode;

  constructor(code: ByoRegistrationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Loopback literals a dev stack federates to.
 *
 * `assertSafeMetadataUrl` refuses loopback outright, and it is right to: in
 * production nothing a visitor names should resolve to this machine. But the
 * reference IdP and the whole local stack live on `127.0.0.1`, so a deployment
 * that already opted into dev defaults (never production —
 * `assertSecureConfig` forbids the combination) gets exactly this exception:
 * an IP LITERAL in 127/8 or `::1`. Names are deliberately excluded, including
 * `localhost` and `*.localhost`, because a name can be made to resolve
 * anywhere and the guard would then be judging the wrong thing.
 */
function isDevLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "::1") return true;
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  return (
    octets[0] === "127" &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * The fence in front of every URL this module dereferences: the issuer the
 * visitor typed, and the `registration_endpoint` their discovery document
 * names. Both are equally untrusted — a document is not an authority.
 */
export function assertSafeUpstreamUrl(ctx: AppContext, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
  }
  if (url.username || url.password) {
    throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
  }
  const httpAllowed = ctx.config.allowDevDefaults && url.protocol === "http:";
  if (url.protocol !== "https:" && !httpAllowed) {
    throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
  }
  if (ctx.config.allowDevDefaults && isDevLoopbackHost(url.hostname)) {
    return url;
  }
  try {
    return assertPublicUpstreamUrl(url);
  } catch (error) {
    if (error instanceof UnsafeUpstreamError) {
      throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
    }
    throw error;
  }
}

/**
 * Dereference an upstream URL behind that fence. The literal check alone is
 * not enough — `idp.attacker.example` can resolve to `10.0.0.1` — so the name
 * is resolved, every address judged, and the socket pinned to one that
 * passed (`guardedFetch`). Only the dev loopback literal skips resolution.
 */
export async function upstreamFetch(
  ctx: AppContext,
  raw: string,
  init: GuardedFetchInit,
): Promise<Response> {
  const url = assertSafeUpstreamUrl(ctx, raw);
  const dev = ctx.config.allowDevDefaults && isDevLoopbackHost(url.hostname);
  try {
    return await guardedFetch(url, !dev, init);
  } catch (error) {
    if (!(error instanceof UnsafeUpstreamError)) throw error;
    throw new ByoRegistrationError("invalid_issuer", INVALID_ISSUER_MESSAGE);
  }
}
