import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import {
  type MagicLinkMetadata,
  type UpstreamAuthBundle,
  createUpstreamAuth,
} from "@opensesame/auth-upstream";
import {
  type BoundaryValue,
  type ProvisionalSession,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  ProvisionalMintRefusedError,
  mintProvisionalForInteraction,
} from "../interactions/handlers.js";
import { normalizeIssuer } from "../interactions/registry.js";
import { ensurePersonalOnAuthenticatedSession } from "../routes/projects.js";
import { attachVerifiedExternalIdentity } from "./identity-link.js";

/**
 * The bridge between Better Auth and canonical identity (C20 / D16 / T33).
 *
 * Better Auth is mounted (ADR 0057 supersedes ADR 0052 §6) and owns exactly one
 * thing: proving that whoever clicked the link controls the address it was sent
 * to. What it emphatically does not own is *who that is*. Its user table is an
 * implementation detail of the proof; the canonical account is a row in
 * `principals`, and `better_auth_subjects` is the only bridge between them.
 *
 * That is a security boundary, not a style preference. A Better Auth user id
 * must never become a principal id, appear in an API response, an audit row, or
 * a token — so nothing here ever puts `subject.id` anywhere except the mapping
 * table. The external identity this admission writes is keyed by the *email*,
 * which is the thing the human actually proved, and which the verified-email
 * policy (D15) can then match against every other leg that yields one.
 */

/** The Better Auth subject a completed magic-link verification describes. */
export type BetterAuthSubject = {
  /** Better Auth's own user id. Goes into the mapping table and nowhere else. */
  id: string;
  email?: string;
  emailVerified?: boolean;
};

export type BetterAuthBridgeErrorCode =
  /** The verification did not carry an address asserted as verified. */
  | "unverified_email"
  /** The mapped principal is gone, suspended, or otherwise not signing in. */
  | "principal_unavailable"
  /** The address is already bound to a different principal by tuple. */
  | "identity_collision"
  /** The deployment is at its provisional-principal ceiling. */
  | "provisional_capacity"
  /** The per-address mint budget refused. */
  | "rate_limited";

/**
 * What a completed magic-link admission hands its caller: the canonical
 * principal, and a first-party bearer bound to it. Deliberately the same shape
 * `POST /v1/principals/federated-session` answers with (C13), so a client
 * adopts either the same way.
 */
export type BridgedSession = {
  principalId: string;
  accessToken: string;
};

export class BetterAuthBridgeError extends Error {
  override readonly name = "BetterAuthBridgeError";
  readonly code: BetterAuthBridgeErrorCode;

  constructor(code: BetterAuthBridgeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The metadata key carrying the interaction the request started from, so the
 * link built in `sendMagicLink` can land back inside that interaction.
 */
export const MAGIC_LINK_INTERACTION_KEY = "interactionUid";

/** Session scope for an email-verified admission: identical to every other leg. */
const PROVISIONAL_ACTIONS = [
  "project.create",
  "project.create_temporary",
  "resource.create_temporary",
  "claim.create",
  "agent.register_ephemeral",
  "session.continue_anonymous",
] as const;

/**
 * Addresses are compared and stored lowercased with surrounding space removed.
 * Nothing more: local-part normalization (dots, `+tags`) differs per provider,
 * and guessing wrong would either merge two people or split one.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The issuer recorded on an email identity: this deployment.
 *
 * The magic-link proof is OpenSesame's own — no upstream vouched for it — so
 * the issuer names this identity provider, and the tuple
 * `("email", <this issuer>, "", <address>)` is what a returning human matches
 * on. Two deployments therefore never share an email identity row, which is
 * the same containment every other issuer gets.
 */
export function emailIdentityIssuer(ctx: AppContext): string {
  return normalizeIssuer(ctx.config.issuer);
}

/**
 * Better Auth signs its own session cookies and verification values, so it
 * needs a secret. Derived from the deployment's existing pepper via HKDF rather
 * than adding another environment variable to keep in sync: distinct info
 * string, so this key and the claim pepper cannot be substituted for one
 * another even though one is derived from the other.
 */
function betterAuthSecret(ctx: AppContext): string {
  return Buffer.from(
    hkdfSync(
      "sha256",
      ctx.config.claimPepper,
      "",
      "opensesame/better-auth",
      32,
    ),
  ).toString("base64url");
}

function magicLinkUrl(
  ctx: AppContext,
  token: string,
  metadata: MagicLinkMetadata | undefined,
): string {
  const base = ctx.config.publicUrl.replace(/\/+$/, "");
  // SAFETY: metadata is whatever the request handed `signInMagicLink`; the
  // JSON boundary is exactly what `isString` is the guard for.
  const claimed: BoundaryValue = overlapCast(
    metadata?.[MAGIC_LINK_INTERACTION_KEY],
  );
  const uid = isString(claimed) ? claimed : undefined;
  const query = `?token=${encodeURIComponent(token)}`;
  // Two landing places, one token. A link started from the hosted login page
  // resumes that interaction; a link started by a first-party client (Pages,
  // the console) lands on the API route that answers with a bearer.
  return uid
    ? `${base}/interaction/${encodeURIComponent(uid)}/federated/email/verify${query}`
    : `${base}/v1/auth/magic-link/complete${query}`;
}

function magicLinkText(url: string, ttlMinutes: number): string {
  return [
    "Someone asked to sign in to OpenSesame with this email address.",
    "",
    `Open this link to finish signing in (it works once, and expires in ${ttlMinutes} minutes):`,
    url,
    "",
    "If that was not you, nothing has happened and you can ignore this message.",
  ].join("\n");
}

const MAGIC_LINK_TTL_SECONDS = 600;

/**
 * One Better Auth instance per control plane.
 *
 * It has to be exactly one: the verification value written when the link is
 * requested is read back when the link is clicked, and a second instance would
 * be a second store that has never heard of the token. Keyed on the context
 * rather than held module-global so two control planes in one process (every
 * route suite in this repo) do not share an account store.
 */
const bundles = new WeakMap<AppContext, UpstreamAuthBundle>();

export function upstreamAuthFor(ctx: AppContext): UpstreamAuthBundle {
  const existing = bundles.get(ctx);
  if (existing) return existing;
  const bundle = createUpstreamAuth({
    baseURL: ctx.config.publicUrl.replace(/\/+$/, ""),
    basePath: "/v1/auth",
    secret: betterAuthSecret(ctx),
    mappingStore: ctx.mappings,
    // The magic-link request is a cross-origin POST from Pages and the console;
    // Better Auth checks the Origin header against this list.
    trustedOrigins: [...ctx.config.corsOrigins],
    magicLink: {
      expiresInSeconds: MAGIC_LINK_TTL_SECONDS,
      sendMagicLink: async ({ email, token, metadata }) => {
        const url = magicLinkUrl(ctx, token, metadata);
        await ctx.mailer.send({
          to: email,
          subject: "Your OpenSesame sign-in link",
          text: magicLinkText(url, MAGIC_LINK_TTL_SECONDS / 60),
        });
      },
    },
  });
  bundles.set(ctx, bundle);
  return bundle;
}

/**
 * Ask Better Auth to mint and deliver a link.
 *
 * Answers nothing about the address: the same `void` for a first-time visitor
 * and for a returning one, because the caller renders the same "check your
 * email" page either way. Anything else would make an unauthenticated form
 * into an account-existence oracle.
 */
export async function requestMagicLink(
  ctx: AppContext,
  email: string,
  metadata: Record<string, string>,
): Promise<void> {
  const { auth } = upstreamAuthFor(ctx);
  await auth.api.signInMagicLink({
    body: { email, metadata },
    headers: new Headers(),
  });
}

/**
 * Consume a magic-link token.
 *
 * Called server-side rather than by letting the browser hit Better Auth's own
 * `/magic-link/verify`: that endpoint answers with the Better Auth user record,
 * which is precisely the thing that must not cross the API boundary (T33). The
 * token is consumed atomically inside this call, so a replayed link finds
 * nothing and this returns `undefined`.
 */
export async function verifyMagicLinkToken(
  ctx: AppContext,
  token: string,
): Promise<BetterAuthSubject | undefined> {
  const { auth } = upstreamAuthFor(ctx);
  try {
    const verified = await auth.api.magicLinkVerify({
      query: { token },
      headers: new Headers(),
    });
    return {
      id: verified.user.id,
      email: verified.user.email,
      emailVerified: verified.user.emailVerified,
    };
  } catch {
    // Better Auth signals an unusable token by throwing a redirect-to-error;
    // an expired, unknown or already-spent token are one outcome here.
    return undefined;
  }
}

/** Mint a first-party bearer for a principal that already exists. */
async function issueProvisionalBearer(
  ctx: AppContext,
  principalId: string,
): Promise<string> {
  const now = ctx.clock();
  const session: ProvisionalSession = {
    id: `ps_${randomBytes(16).toString("hex")}`,
    principalId,
    quotaProfile: "anonymous",
    allowedActions: [...PROVISIONAL_ACTIONS],
    createdAt: now,
    expiresAt: new Date(now.getTime() + ctx.config.provisionalTtlMs),
  };
  const accessToken = `pst_${randomBytes(24).toString("base64url")}`;
  ctx.stores.provisionalSessions.set(session.id, session);
  ctx.stores.provisionalTokens.set(accessToken, session.id);
  return accessToken;
}

/**
 * Resolve a Better Auth subject to a canonical principal and a session (C20).
 *
 * Order, and why:
 *
 *  1. the `better_auth_subjects` mapping — a returning human whose Better Auth
 *     user this deployment has already bound to a principal;
 *  2. the identity tuple `("email", issuer, address)` — the same human arriving
 *     through a *new* Better Auth user record, which happens whenever that
 *     store is rebuilt underneath a durable principal;
 *  3. mint, then `attachVerifiedExternalIdentity`, which applies the D15
 *     verified-email policy and may hand the identity to a principal that
 *     already owns this address through some other leg entirely.
 *
 * Step 3's return is authoritative: when D15 matched, the principal signing in
 * is the one that owned the address, not the one just minted.
 */
export async function principalForBetterAuthSubject(
  ctx: AppContext,
  subject: BetterAuthSubject,
  correlationId: string = randomUUID(),
): Promise<BridgedSession> {
  // Better Auth marks a magic-link user verified as part of consuming the
  // token; anything else did not prove control of an address and has no
  // business promoting a principal.
  if (!subject.email || subject.emailVerified !== true) {
    throw new BetterAuthBridgeError(
      "unverified_email",
      "The sign-in did not carry a verified email address",
    );
  }
  const emailNormalized = normalizeEmail(subject.email);
  const issuer = emailIdentityIssuer(ctx);

  const mapped = await ctx.repos.betterAuthSubjects.getByBetterAuthUserId(
    subject.id,
  );
  const existing = mapped
    ? undefined
    : await ctx.repos.externalIdentities.findByTuple({
        kind: "email",
        issuer,
        subject: emailNormalized,
      });

  const knownPrincipalId = mapped?.principalId ?? existing?.principalId;
  if (knownPrincipalId) {
    const principal = await ctx.repos.principals.getById(knownPrincipalId);
    if (!principal || principal.state !== "active") {
      throw new BetterAuthBridgeError(
        "principal_unavailable",
        "This account is not able to sign in.",
      );
    }
    if (!mapped) {
      await ctx.repos.betterAuthSubjects.link({
        betterAuthUserId: subject.id,
        principalId: knownPrincipalId,
        linkedAt: ctx.clock(),
      });
    }
    return {
      principalId: knownPrincipalId,
      accessToken: await issueProvisionalBearer(ctx, knownPrincipalId),
    };
  }

  // Brand-new here: mint the same provisional principal the "Start a session"
  // action would, under the same capacity and budget fences, then promote it in
  // place by attaching the verified identity. The address, not the Better Auth
  // user id, is the fingerprint the mint budget counts — one address cannot
  // mint an unbounded number of principals by clicking links.
  const fingerprint = createHash("sha256")
    .update("email:")
    .update(emailNormalized)
    .digest("hex")
    .slice(0, 16);
  let minted: BridgedSession;
  try {
    minted = await mintProvisionalForInteraction(
      ctx,
      fingerprint,
      correlationId,
    );
  } catch (error) {
    if (error instanceof ProvisionalMintRefusedError) {
      throw new BetterAuthBridgeError(error.code, "Too many sign-in attempts.");
    }
    throw error;
  }

  const attached = await attachVerifiedExternalIdentity(
    ctx,
    minted.principalId,
    {
      kind: "email",
      issuer,
      subject: emailNormalized,
      correlationId,
      emailNormalized,
      emailVerified: true,
    },
  );
  if (!attached.ok) {
    throw new BetterAuthBridgeError("identity_collision", attached.message);
  }
  // Follow the identity row, never the mint: D15 may have attached this
  // address to a principal that already owned it through another leg, and the
  // principal minted a moment ago is then not the account signing in.
  const principalId = attached.identity.principalId;

  await ctx.repos.betterAuthSubjects.link({
    betterAuthUserId: subject.id,
    principalId,
    linkedAt: ctx.clock(),
  });
  // Same first-authenticated-session guarantee every other admission surface
  // gives: a principal that just became verified gets its personal project.
  await ensurePersonalOnAuthenticatedSession(ctx, principalId, correlationId);
  // The `principal.identity_linked` event (with `via: "email_magic_link"`,
  // C5's mapping for `kind: "email"`) is emitted by
  // `attachVerifiedExternalIdentity` itself — the single admission chokepoint
  // audits every leg identically, and a second event here would double-count.

  return {
    principalId,
    accessToken:
      principalId === minted.principalId
        ? minted.accessToken
        : // The minted session belongs to the minted principal and to nothing
          // else; when D15 redirected the identity, that bearer names an
          // account this sign-in did not complete as.
          await issueProvisionalBearer(ctx, principalId),
  };
}
