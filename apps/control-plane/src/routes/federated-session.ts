import { randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { parseOriginClientId } from "@opensesame/oauth-provider";
import {
  type ProvisionalSession,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { Variables } from "../middleware/context.js";

/**
 * Brokered session adoption (C13, D8).
 *
 * A static page — Pages, or any `apps/example-static-rp`-shaped site — that
 * wants a provider this deployment brokers cannot run the upstream leg itself:
 * Google and friends serve no CORS on their token endpoints. It instead runs
 * the origin-profile code flow against THIS server, and the hosted login page
 * runs the upstream leg. That works, and then leaves one problem.
 *
 * The id_token it gets back carries a *pairwise* subject minted for the page's
 * origin (ADR 0050). POSTing it to `/v1/principals/link-identities` would
 * attach that pairwise identity to whatever provisional session the page
 * happens to be holding — i.e. to the wrong principal, permanently (T23).
 * Cookie resume cannot rescue it either: `os_provisional` is `SameSite=Lax`
 * and is not sent on a cross-origin XHR from the page's origin.
 *
 * So the page brings its **access token** here instead. This route looks it up
 * in oidc-provider's own store, reads the account it was issued for, and mints
 * a first-party provisional bearer bound to THAT principal. No new principal,
 * no new identity row, no claim about who anybody is that oidc-provider did
 * not already decide when it issued the token.
 *
 * The token is the credential, so the route takes no auth middleware — and
 * answers a single uniform `invalid_token` for unknown, expired, wrong-kind
 * and account-less tokens alike. Distinguishing them would tell an attacker
 * holding a random string which part of it was nearly right.
 */

/** Nobody's access token is longer than this; anything bigger is not one. */
const MAX_ACCESS_TOKEN_LENGTH = 8192;

const FederatedSessionRequestSchema = z.object({
  accessToken: z.string().min(1).max(MAX_ACCESS_TOKEN_LENGTH),
});

/**
 * The panva model surface this route uses. `provider.AccessToken.find(value)`
 * resolves an opaque access token through the configured adapter and returns
 * `undefined` for an unknown token, a payload that fails verification, or one
 * whose `exp` has passed — expiry is enforced inside `find` unless
 * `ignoreExpiration` is passed, and it deliberately is not.
 *
 * Typed locally because `packages/oauth-provider`'s ambient declaration for
 * oidc-provider (there is no bundled `.d.ts`) declares only the surface that
 * package configures. Read from the installed source before writing, per T24.
 */
type AccessTokenModel = {
  find(
    value: string,
    options?: { ignoreExpiration?: boolean },
  ): Promise<
    | {
        accountId?: string;
        clientId?: string;
        isExpired?: boolean;
        exp?: number;
      }
    | undefined
  >;
};

type ProviderAccessTokens = { AccessToken: AccessTokenModel };

function accessTokens(ctx: AppContext): AccessTokenModel {
  // SAFETY: panva's Provider exposes AccessToken as a lazily built model class
  // carrying the static `find` above; the ambient shim declares neither.
  const provider: ProviderAccessTokens = overlapCast(ctx.oauth.provider);
  return provider.AccessToken;
}

export type FederatedSessionAdoption = {
  principalId: string;
  accessToken: string;
  expiresAt: string;
};

/**
 * Mint a first-party provisional bearer for a principal that already exists.
 *
 * Deliberately NOT `mintProvisionalForInteraction`: that mints a principal,
 * and the whole point here is that the principal was decided upstream. This
 * writes one session and one token into the same stores the interaction path
 * uses, so `middleware/auth.ts` authenticates it identically and
 * `POST /v1/principals/provisional/revoke` ends it identically.
 */
async function adoptSession(
  ctx: AppContext,
  principalId: string,
  correlationId: string,
): Promise<FederatedSessionAdoption> {
  const now = ctx.clock();
  const session: ProvisionalSession = {
    id: `ps_${randomBytes(16).toString("hex")}`,
    principalId,
    quotaProfile: "anonymous",
    allowedActions: [
      "project.create",
      "project.create_temporary",
      "resource.create_temporary",
      "claim.create",
      "agent.register_ephemeral",
      "session.continue_anonymous",
    ],
    createdAt: now,
    expiresAt: new Date(now.getTime() + ctx.config.provisionalTtlMs),
  };
  const accessToken = `pst_${randomBytes(24).toString("base64url")}`;
  ctx.stores.provisionalSessions.set(session.id, session);
  ctx.stores.provisionalTokens.set(accessToken, session.id);

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "principal.session_adopted",
    outcome: "succeeded",
    principalId,
    sessionId: session.id,
    correlationId,
    actorType: "human",
    metadata: {
      action: "principal.session_adopt",
      via: "oidc_access_token",
    },
  });

  return {
    principalId,
    accessToken,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/**
 * `POST /v1/principals/federated-session` (C13).
 *
 * INTEGRATOR: mount alongside the principal routes in `src/app.ts` — S1 owns
 * that file, so the line is not applied here:
 *
 *   app.route("/v1/principals", createFederatedSessionRoutes());
 *
 * It is a separate router rather than a handler inside `routes/principals.ts`
 * because that file belongs to another swarm this cycle; the path it serves is
 * the contract's, either way.
 */
export function createFederatedSessionRoutes(): Hono<{ Variables: Variables }> {
  const routes = new Hono<{ Variables: Variables }>();

  routes.post("/federated-session", async (c) => {
    const ctx = c.get("ctx");
    const invalid = () => c.json({ error: "invalid_token" }, 401);

    let parsed: ReturnType<typeof FederatedSessionRequestSchema.safeParse>;
    try {
      parsed = FederatedSessionRequestSchema.safeParse(await c.req.json());
    } catch {
      // Not JSON at all. Same answer as a token that does not resolve: this
      // endpoint has exactly one failure mode by design.
      return invalid();
    }
    if (!parsed.success) return invalid();

    const token = await accessTokens(ctx).find(parsed.data.accessToken);
    // `find` already refuses an expired token; the explicit check keeps that
    // guarantee local rather than borrowing it from a library default that a
    // future upgrade could soften.
    if (!token || token.isExpired) return invalid();
    const accountId = token.accountId;
    // A client-credentials token has no account. It authenticates software,
    // and no session belongs to it.
    if (!isString(accountId) || accountId.length === 0) return invalid();

    /*
     * Which client the token was issued to decides whether it may be spent
     * here at all.
     *
     * What this route hands back is a first-party `pst_` bearer, and that is
     * not scope-limited: `authMiddleware` resolves it to a full principal for
     * every route behind `requirePrincipal()` — projects, claims,
     * organizations, SCIM token minting. An OAuth access token is narrower
     * than that by construction, so exchanging *any* of them for one would let
     * a pre-registered relying party that a user granted `openid` alone walk
     * away with the user's whole identity-plane session.
     *
     * The exchange exists for exactly one caller: an origin-profile static
     * site completing the brokered flow against this deployment (D8/C13). So
     * the client is looked up and required to have been admitted through that
     * path. A `origin:`-shaped id is not enough on its own — that is a string,
     * and a pre-registered client could be given one.
     */
    const clientId = token.clientId;
    if (!isString(clientId) || parseOriginClientId(clientId) === undefined) {
      return invalid();
    }
    const client = await ctx.oauth.clientStore.findById(clientId);
    if (!client || client.admissionMode !== "origin_profile") return invalid();

    const principal = await ctx.repos.principals.getById(accountId);
    if (!principal || principal.state !== "active") return invalid();

    const adopted = await adoptSession(
      ctx,
      principal.id,
      c.get("correlationId"),
    );
    return c.json(adopted, 200);
  });

  return routes;
}
