import { appendAuditEvent } from "@opensesame/audit";
import {
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import {
  type RemoteJWKSet,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import type { AppContext } from "../context.js";
import { revokeSessionsForIdentity } from "../interactions/federated.js";
import { normalizeIssuer } from "../interactions/registry.js";
import {
  type TrustResolution,
  resolveTrustedIssuer,
} from "../interactions/trust.js";
import type { Variables } from "../middleware/context.js";
import { orgAssertionSeams } from "./org-assertion.js";
import { revokeOrganizationMembership } from "./organizations.js";

/**
 * OIDC Back-Channel Logout 1.0 (C17, D13, ADR 0056).
 *
 * This is how an upstream tells us a human's session is over — the
 * deprovisioning signal that replaces holding upstream refresh tokens we
 * deliberately never take custody of (ADR 0005). The IdP POSTs a signed
 * `logout_token`; we end that subject's sessions here and, when the issuer is
 * a tenant's, the membership it authorised.
 *
 * It is an unauthenticated POST that revokes sessions, so the fences are the
 * whole design:
 *
 * - the issuer must resolve through the one trust fence (C2) before a single
 *   byte of it is dereferenced;
 * - the signature must verify against that issuer's published JWKS;
 * - the token must carry the backchannel-logout event and a subject;
 * - it must be fresh, because a captured logout token is otherwise a
 *   permanent "sign this person out" button;
 * - **it must NOT carry `nonce`** — that claim is what an id_token has, and
 *   the spec forbids it here precisely so a replayed id_token cannot be passed
 *   off as a logout (T29);
 * - and the whole endpoint is rate-limited, because the signature check is a
 *   remote key fetch and the effect is session destruction.
 *
 * A token that verifies always answers `200` with an empty body, whether it
 * matched a live session or nobody at all. Answering differently would turn
 * this into an oracle for "does this person have an account here".
 */

const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
const ALLOWED_ALGS = ["RS256", "ES256"] as const;
const ALLOWED_ALG_SET = new Set<string>(ALLOWED_ALGS);

/** Nobody's logout token is longer than this. */
const MAX_LOGOUT_TOKEN_LENGTH = 8192;

/** OIDC BCL 1.0 §2.6: `iat` must be recent. */
export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 120;

const BUDGET_WINDOW_MS = 60_000;
/** Per-issuer budget: an IdP signing out a fleet still fits comfortably. */
const BUDGET_PER_ISSUER = 30;
/**
 * Whole-endpoint budget. The per-issuer key comes from the *unverified* token,
 * so an attacker can mint a new key per request; only a global ceiling bounds
 * that, and it sits well above any plausible real logout rate.
 */
const BUDGET_TOTAL = 120;

const attempts = new Map<string, number[]>();
const jwksCache = new Map<string, RemoteJWKSet>();

/**
 * Test hook: clear the rate-limit window and the JWKS cache.
 *
 * Both are module-global by design — they must outlive a request — so a suite
 * that starts a fresh reference IdP calls this in `beforeAll` and `afterAll`,
 * exactly as it does for the discovery cache (T1).
 */
export function resetBackchannelLogoutBudget(): void {
  attempts.clear();
  jwksCache.clear();
}

function withinBudget(key: string, limit: number, now: number): boolean {
  const window = (attempts.get(key) ?? []).filter(
    (at) => at > now - BUDGET_WINDOW_MS,
  );
  if (window.length >= limit) {
    attempts.set(key, window);
    return false;
  }
  window.push(now);
  attempts.set(key, window);
  return true;
}

/**
 * The issuer the token claims, read WITHOUT verifying it.
 *
 * That is safe and necessary: a JWT names its issuer before anyone can check
 * the signature, and the claim is used for exactly two things — picking the
 * rate-limit bucket, and asking the trust fence whether we know this issuer at
 * all. Nothing is dereferenced and no effect is applied until `jwtVerify` has
 * agreed.
 */
function claimedIssuer(token: string): string | undefined {
  try {
    const header = decodeProtectedHeader(token);
    if (!isString(header.alg) || !ALLOWED_ALG_SET.has(header.alg)) {
      return undefined;
    }
    const claims = decodeJwt(token);
    return isString(claims.iss) ? normalizeIssuer(claims.iss) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The issuer's key set, fetched through the same guard the org-assertion leg
 * uses and cached per JWKS URI.
 *
 * Without the cache, every unauthenticated POST would become an outbound
 * request to somebody else's server — a reflection amplifier with our name on
 * the packets.
 */
async function keysFor(
  ctx: AppContext,
  issuer: string,
): Promise<RemoteJWKSet | undefined> {
  const blockPrivateHosts = !ctx.config.allowDevDefaults;
  let jwksUri: string;
  try {
    jwksUri = await orgAssertionSeams.discoverJwksUri(
      issuer,
      blockPrivateHosts,
    );
  } catch {
    return undefined;
  }
  const cached = jwksCache.get(jwksUri);
  if (cached) return cached;
  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    return undefined;
  }
  const keys = createRemoteJWKSet(url, {
    // Redirects are refused rather than followed: a 302 off the JWKS URI would
    // walk past the guard the discovery step just applied.
    [customFetch]: (target, options) =>
      fetch(target, {
        headers: options.headers,
        method: options.method,
        redirect: "error",
        signal: options.signal,
      }),
  });
  jwksCache.set(jwksUri, keys);
  return keys;
}

type VerifiedLogoutToken = { subject?: string; sessionId?: string };

/**
 * Everything OIDC Back-Channel Logout 1.0 §2.6 requires of the token, after
 * the signature. `undefined` means "refuse"; the caller never says which rule
 * failed.
 */
function readLogoutClaims(
  payload: JsonObject,
): VerifiedLogoutToken | undefined {
  // §2.6.2: a logout token MUST NOT contain a nonce. This is the fence against
  // presenting a stolen id_token as a logout instruction (T29).
  if (payload.nonce !== undefined) return undefined;

  const events = payload.events;
  if (!isJsonObject(events)) return undefined;
  if (!(LOGOUT_EVENT in events)) return undefined;

  const subject = isString(payload.sub) ? payload.sub : undefined;
  const sessionId = isString(payload.sid) ? payload.sid : undefined;
  // §2.6: at least one of sub or sid. Neither means the token names nobody.
  if (!subject && !sessionId) return undefined;
  return {
    ...(subject !== undefined ? { subject } : undefined),
    ...(sessionId !== undefined ? { sessionId } : undefined),
  };
}

/** End memberships this issuer granted, when it belongs to a tenant. */
async function endOrganizationMemberships(
  ctx: AppContext,
  resolution: TrustResolution,
  issuer: string,
  subject: string,
  correlationId: string,
): Promise<number> {
  if (resolution.source !== "org") return 0;
  const principalIds = new Set<string>();
  for (const kind of ["oidc", "oauth2", "saml", "ldap", "email"]) {
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind,
      issuer,
      subject,
    });
    if (identity) principalIds.add(identity.principalId);
  }
  let ended = 0;
  for (const principalId of principalIds) {
    const result = await revokeOrganizationMembership(ctx, {
      organizationId: resolution.organizationId,
      principalId,
      correlationId,
      reason: "upstream_backchannel_logout",
    });
    if (result.membershipRemoved) ended += 1;
  }
  return ended;
}

export function createBackchannelLogoutRoutes(): Hono<{
  Variables: Variables;
}> {
  const routes = new Hono<{ Variables: Variables }>();

  routes.post("/backchannel-logout", async (c) => {
    const ctx = c.get("ctx");
    const now = Date.now();
    // The global bucket is charged first and unconditionally: it is the one
    // limit an attacker cannot dodge by varying the token.
    if (!withinBudget("*", BUDGET_TOTAL, now)) return c.body(null, 429);

    const invalid = () => c.json({ error: "invalid_request" }, 400);

    let fields: JsonObject;
    try {
      fields = overlapCast(await c.req.parseBody());
    } catch {
      return invalid();
    }
    const token = isString(fields.logout_token) ? fields.logout_token : "";
    if (!token || token.length > MAX_LOGOUT_TOKEN_LENGTH) return invalid();

    const issuer = claimedIssuer(token);
    if (!issuer) return invalid();
    if (!withinBudget(issuer, BUDGET_PER_ISSUER, now)) {
      return c.body(null, 429);
    }

    // The trust fence before the network: an issuer nobody configured gets no
    // discovery request, so this endpoint cannot be pointed at a third party.
    const resolution = await resolveTrustedIssuer(ctx, issuer);
    if (!resolution) return invalid();

    const keys = await keysFor(ctx, issuer);
    if (!keys) return invalid();

    let claims: VerifiedLogoutToken | undefined;
    try {
      const verified = await jwtVerify(token, keys, {
        issuer,
        algorithms: [...ALLOWED_ALGS],
        clockTolerance: 5,
        maxTokenAge: LOGOUT_TOKEN_MAX_AGE_SECONDS,
      });
      claims = readLogoutClaims(overlapCast(verified.payload));
    } catch {
      return invalid();
    }
    if (!claims) return invalid();

    // A `sid`-only token names an upstream session, and this service keeps no
    // record of upstream session ids — there is nothing it could revoke. It is
    // accepted (the spec allows either claim) and has no effect, which is also
    // what the uniform 200 already says to every caller.
    const correlationId = c.get("correlationId");
    let sessionsRevoked = 0;
    let membershipsEnded = 0;
    if (claims.subject) {
      sessionsRevoked = await revokeSessionsForIdentity(
        ctx,
        issuer,
        claims.subject,
      );
      membershipsEnded = await endOrganizationMemberships(
        ctx,
        resolution,
        issuer,
        claims.subject,
        correlationId,
      );
    }

    // Audited internally, not answered: the trail records how much this logout
    // actually ended, while the response says only that it was accepted.
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "principal.upstream_logout",
      outcome: "succeeded",
      correlationId,
      actorType: "system",
      actorId: "upstream",
      metadata: {
        action: "principal.upstream_logout",
        issuer,
        via: "backchannel_logout",
        count: sessionsRevoked + membershipsEnded,
      },
    });

    // 200, empty, always — matched or not (T29).
    return c.body(null, 200);
  });

  return routes;
}
