import { appendAuditEvent } from "@opensesame/audit";
import type { AppContext } from "../context.js";
import { revokeSessionTokens } from "../repos/session-storage.js";

const REVOCABLE_IDENTITY_KINDS = [
  "oidc",
  "oauth2",
  "saml",
  "ldap",
  "email",
] as const;

/**
 * Revoke every live provisional session belonging to the principals linked to
 * `(issuer, subject)`; returns how many sessions ended (C17).
 *
 * This is the effect half of OIDC Back-Channel Logout (S10 owns the endpoint
 * that verifies the `logout_token`). It deliberately takes an issuer and a
 * subject rather than a principal id: the caller is holding an upstream
 * assertion, and resolving it to principals here keeps the tuple lookup — the
 * one binding that matters — in one place.
 */
export async function revokeSessionsForIdentity(
  ctx: AppContext,
  issuer: string,
  subject: string,
  tenant?: string,
): Promise<number> {
  const principalIds = new Set<string>();
  for (const kind of REVOCABLE_IDENTITY_KINDS) {
    for (const namespace of tenant ? [undefined, tenant] : [undefined]) {
      const identity = await ctx.repos.externalIdentities.findByTuple({
        kind,
        issuer,
        subject,
        ...(namespace ? { tenant: namespace } : undefined),
      });
      if (identity) principalIds.add(identity.principalId);
    }
  }
  if (principalIds.size === 0) return 0;

  const now = ctx.clock();
  let revoked = 0;
  const sessions = await ctx.stores.provisionalSessions.entries();
  for (const [, session] of sessions) {
    const sessionId = session.id;
    if (!principalIds.has(session.principalId)) continue;
    if (session.revokedAt) continue;
    await ctx.stores.provisionalSessions.set(sessionId, {
      ...session,
      revokedAt: now,
    });
    await revokeSessionTokens(ctx.stores, sessionId);
    revoked += 1;
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "principal.provisional_revoked",
      outcome: "succeeded",
      principalId: session.principalId,
      sessionId,
      correlationId: `upstream-logout-${sessionId}`,
      actorType: "system",
      metadata: {
        action: "principal.provisional_revoke",
        issuer,
        via: "upstream_logout",
      },
    });
  }
  return revoked;
}
