import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { ConflictError } from "@opensesame/database";
import type { ExternalIdentity } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/**
 * Canonical binding of a *verified* upstream OIDC identity to a principal.
 *
 * Extracted verbatim from the `POST /v1/principals/link-identities` handler so
 * the server-side relying-party leg (hosted "Sign in with Google") and the
 * agent-facing id_token link path share one implementation of the same rules.
 * The caller owns verification: by the time this runs, the id_token has already
 * passed issuer allowlisting and `verifyOrgIdToken`.
 */

/**
 * SECURITY INVARIANT (ADR 0033 / ADR 0042): email is NEVER a join key.
 *
 * An identity is looked up, matched, and linked by `(kind, issuer, tenant,
 * subject)` and nothing else. `emailNormalized` / `emailVerified` /
 * `displayHint` are captured for display and support only. If another
 * principal already carries the same normalized email we emit a *denied*
 * `principal.identity_link_email_collision` audit event and then link
 * normally by (issuer, subject) anyway — the email is evidence for humans, not
 * a matching rule. This is why `external_identities.email_normalized` is
 * indexed but deliberately NOT unique: two principals may legitimately share
 * an email string, and an upstream that asserts an email it does not control
 * must never be able to take over an existing principal.
 */

export type AttachIdentityInput = {
  issuer: string;
  subject: string;
  correlationId: string;
  displayHint?: string;
  emailNormalized?: string;
  emailVerified?: boolean;
};

export type AttachIdentityResult =
  | { ok: true; alreadyLinked: boolean; identity: ExternalIdentity }
  | { ok: false; error: "identity_collision"; message: string };

/**
 * Deliberately does not name the bound principal id: echoing it would let any
 * caller enumerate which principal owns an upstream identity.
 */
const IDENTITY_COLLISION_MESSAGE =
  "External identity already bound to another principal; merge requires dual authentication";

/**
 * Bind a verified upstream identity to `principalId`.
 *
 * - idempotent when the same principal already owns the tuple
 *   (`{ ok: true, alreadyLinked: true }`)
 * - refuses when another principal owns it (`identity_collision`)
 * - promotes a provisional principal IN PLACE to active/verified; the
 *   principal id never changes, so a guest keeps everything it created.
 */
export async function attachVerifiedExternalIdentity(
  ctx: AppContext,
  principalId: string,
  input: AttachIdentityInput,
): Promise<AttachIdentityResult> {
  // `tenant` is intentionally omitted: the repositories normalize an absent
  // tenant to "" for both the lookup key and the stored row.
  const existing = await ctx.repos.externalIdentities.findByTuple({
    kind: "oidc",
    issuer: input.issuer,
    subject: input.subject,
  });
  if (existing) {
    if (existing.principalId === principalId) {
      return { ok: true, alreadyLinked: true, identity: existing };
    }
    return {
      ok: false,
      error: "identity_collision",
      message: IDENTITY_COLLISION_MESSAGE,
    };
  }

  // Same email on another principal must never auto-link. Audit and continue.
  if (input.emailNormalized) {
    const emailPeers = await ctx.repos.externalIdentities.listByEmailNormalized(
      input.emailNormalized,
    );
    const foreign = emailPeers.find((e) => e.principalId !== principalId);
    if (foreign) {
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "principal.identity_link_email_collision",
        outcome: "denied",
        principalId,
        correlationId: input.correlationId,
        metadata: {
          action: "principal.link_identity",
          note: "email_not_used_for_link",
        },
      });
    }
  }

  const now = ctx.clock();
  const identity: ExternalIdentity = {
    id: `xid_${randomUUID()}`,
    principalId,
    kind: "oidc",
    issuer: input.issuer,
    subject: input.subject,
    assurance: "verified",
    linkedAt: now,
    metadata: {},
    ...(input.displayHint !== undefined
      ? { displayHint: input.displayHint }
      : undefined),
    ...(input.emailNormalized !== undefined
      ? { emailNormalized: input.emailNormalized }
      : undefined),
    ...(input.emailVerified !== undefined
      ? { emailVerified: input.emailVerified }
      : undefined),
  };
  try {
    await ctx.repos.externalIdentities.create(identity);
  } catch (err) {
    if (err instanceof ConflictError) {
      return { ok: false, error: "identity_collision", message: err.message };
    }
    throw err;
  }

  const principal = await ctx.repos.principals.getById(principalId);
  if (
    principal &&
    (principal.assurance === "provisional" || principal.state === "provisional")
  ) {
    await ctx.repos.principals.update(
      principalId,
      {
        state: "active",
        assurance: "verified",
        verifiedAt: now,
        updatedAt: now,
      },
      principal.version,
    );
  }

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "principal.identity_linked",
    outcome: "succeeded",
    principalId,
    targetType: "external_identity",
    targetId: identity.id,
    correlationId: input.correlationId,
    metadata: {
      action: "principal.link_identity",
      kind: identity.kind,
      issuer: identity.issuer,
      via: "id_token",
    },
  });

  return { ok: true, alreadyLinked: false, identity };
}
