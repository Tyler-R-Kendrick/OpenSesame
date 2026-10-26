import { createHash } from "node:crypto";
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
import {
  assertPublicUpstreamUrl,
  guardedLibraryFetch,
} from "../services/guarded-fetch.js";
import { orgAssertionSeams, originAudiences } from "./org-assertion.js";

/**
 * OIDC Back-Channel Logout 1.0 (C17, D13, ADR 0056).
 *
 * This is how an upstream tells us a human's session is over — the
 * session-termination signal that replaces holding upstream refresh tokens we
 * deliberately never take custody of (ADR 0005). The IdP POSTs a signed
 * `logout_token`; we end that subject's sessions here. Organization membership
 * survives logout; only explicit deprovisioning may remove it.
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
/** Bounded map keys, with the global bucket never evicted. */
const BUDGET_MAX_KEYS = 2048;
const BUDGET_GLOBAL_KEY = "*";
const BUDGET_ISSUER_PREFIX = "issuer:";
/** Remote key sets are cached; an unauthenticated caller must not grow it forever. */
const JWKS_CACHE_MAX_ENTRIES = 256;

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
  // Prune every bucket on every request, not just the one being charged: the
  // key is attacker-chosen, so otherwise each token adds one row for the life
  // of the process.
  for (const [candidate, times] of attempts) {
    const live = times.filter((at) => at > now - BUDGET_WINDOW_MS);
    if (live.length === 0) attempts.delete(candidate);
    else if (live.length !== times.length) attempts.set(candidate, live);
  }
  const bucket = `${BUDGET_ISSUER_PREFIX}${key}`;
  const window = attempts.get(bucket) ?? [];
  if (window.length >= limit) {
    attempts.set(bucket, window);
    return false;
  }
  window.push(now);
  attempts.set(bucket, window);
  while (attempts.size > BUDGET_MAX_KEYS) {
    // Never evict the global bucket: it is the one ceiling an attacker cannot
    // rotate their own key to escape.
    const victim = [...attempts.keys()].find(
      (candidate) =>
        candidate !== `${BUDGET_ISSUER_PREFIX}${BUDGET_GLOBAL_KEY}`,
    );
    if (victim === undefined) break;
    attempts.delete(victim);
  }
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
    // The document is the issuer's, not ours: the `jwks_uri` it names gets
    // the same fence the issuer did, or a BYO record — registered by anyone —
    // turns this unauthenticated POST into a fetch of `169.254.169.254`.
    url = blockPrivateHosts
      ? assertPublicUpstreamUrl(jwksUri)
      : new URL(jwksUri);
  } catch {
    return undefined;
  }
  const keys = createRemoteJWKSet(url, {
    // Resolved, address-pinned and redirect-refusing (`guardedFetch`): a 302
    // or a private DNS answer off the JWKS URI is refused, not followed.
    [customFetch]: guardedLibraryFetch(blockPrivateHosts),
  });
  jwksCache.set(jwksUri, keys);
  while (jwksCache.size > JWKS_CACHE_MAX_ENTRIES) {
    const oldest = jwksCache.keys().next().value;
    if (oldest === undefined) break;
    jwksCache.delete(oldest);
  }
  return keys;
}

type VerifiedLogoutToken = { subject?: string; sessionId?: string };

/**
 * Audience values this deployment will accept for a logout token.
 *
 * OIDC Back-Channel Logout §2.6 requires `aud` to identify the relying party
 * the token was issued to. Accepting any audience would let a token minted for
 * another application at the same issuer end sessions here. The set is built
 * from what this deployment actually is: its own issuer, its origin-profile
 * clients, and the client id the tenant or BYO record registered.
 */
async function expectedAudiences(
  ctx: AppContext,
  issuer: string,
  resolution: TrustResolution,
): Promise<string[]> {
  const accepted = new Set<string>([
    ctx.config.issuer,
    ctx.config.publicUrl,
    ...originAudiences(ctx.config),
  ]);
  const credentials = ctx.config.upstreamClientCredentials;
  if (
    credentials &&
    normalizeIssuer(credentials.issuer) === normalizeIssuer(issuer)
  ) {
    accepted.add(credentials.clientId);
  }
  if (resolution.source === "static") {
    if (resolution.provider.clientId) {
      accepted.add(resolution.provider.clientId);
    }
  } else if (resolution.source === "byo") {
    accepted.add(resolution.record.clientId);
  } else {
    const organization = await ctx.stores.organizations.get(
      resolution.organizationId,
    );
    if (organization?.ssoClientId) accepted.add(organization.ssoClientId);
  }
  return [...accepted].filter((audience) => audience.length > 0);
}

async function claimLogout(ctx: AppContext, token: string): Promise<boolean> {
  const callbackDigest = createHash("sha256").update(token).digest("hex");
  const seenAt = ctx.clock();
  return ctx.repos.callbackReplays.claim({
    id: `oidc-logout:${callbackDigest}`,
    providerId: "oidc-logout",
    callbackDigest,
    seenAt,
    expiresAt: new Date(
      seenAt.getTime() + (LOGOUT_TOKEN_MAX_AGE_SECONDS + 10) * 1000,
    ),
  });
}

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
      const audiences = await expectedAudiences(ctx, issuer, resolution);
      const verified = await jwtVerify(token, keys, {
        issuer,
        audience: audiences,
        algorithms: [...ALLOWED_ALGS],
        clockTolerance: 5,
        maxTokenAge: LOGOUT_TOKEN_MAX_AGE_SECONDS,
      });
      claims = readLogoutClaims(overlapCast(verified.payload));
    } catch {
      return invalid();
    }
    if (!claims) return invalid();
    if (!(await claimLogout(ctx, token))) return c.body(null, 200);

    // A `sid`-only token names an upstream session, and this service keeps no
    // record of upstream session ids — there is nothing it could revoke. It is
    // accepted (the spec allows either claim) and has no effect, which is also
    // what the uniform 200 already says to every caller.
    const correlationId = c.get("correlationId");
    let sessionsRevoked = 0;
    if (claims.subject) {
      sessionsRevoked = await revokeSessionsForIdentity(
        ctx,
        issuer,
        claims.subject,
        resolution.source === "org" ? resolution.organizationId : undefined,
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
        count: sessionsRevoked,
      },
    });

    // 200, empty, always — matched or not (T29).
    return c.body(null, 200);
  });

  return routes;
}
