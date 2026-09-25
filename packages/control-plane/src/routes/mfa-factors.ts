import { createHash } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  type AccountFactor,
  type AccountFactorKind,
  TOTP_FACTOR_ID,
  isAccountFactorId,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * The signed-in principal's own account factors (ADR 0140 D10): list them,
 * and remove one.
 *
 * Settings › Security draws these as rows beside the vault's keys, so the
 * listing says what tells one factor from another and nothing that verifies
 * one — never a public key, a TOTP seed, a signature counter or the raw
 * credential id. A passkey is named by the same digest the assertion fence
 * and the audit trail already use (`passkey_digest`), so no new identifier
 * of a credential leaves the service.
 *
 * Removal needs no "last factor" guard: these are second steps the Identity
 * API asks for on top of a session, not the way into the account — the
 * account is reached through its upstream sign-in, so removing the last one
 * cannot lock anybody out. A factor that is not the caller's answers exactly
 * like one that does not exist.
 */
export const mfaFactorRoutes = new Hono<{ Variables: Variables }>();

/** The first 32 hex digits of the credential id's SHA-256, as `mfa.ts` fences it. */
export function passkeyDigest(credentialId: string): string {
  return createHash("sha256").update(credentialId).digest("hex").slice(0, 32);
}

function enrollable(ctx: AppContext): AccountFactorKind[] {
  // TOTP enrolment is the development build's only (`/totp/enroll` refuses
  // with `totp_dev_only` otherwise), so a client is told not to offer it.
  return ctx.config.allowDevDefaults ? ["passkey", "totp"] : ["passkey"];
}

mfaFactorRoutes.get("/factors", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const passkeys = await ctx.passkeys.list(principalId);
  const factors: AccountFactor[] = passkeys
    .map((credential) => {
      const factor: AccountFactor = {
        id: `pk_${passkeyDigest(credential.credentialId)}`,
        kind: "passkey",
      };
      if (credential.createdAt) factor.createdAt = credential.createdAt;
      return factor;
    })
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  if (await ctx.stores.totpSecrets.has(principalId)) {
    factors.push({ id: TOTP_FACTOR_ID, kind: "totp" });
  }
  c.header("cache-control", "no-store");
  return c.json({ ok: true, factors, enrollable: enrollable(ctx) });
});

mfaFactorRoutes.delete("/factors/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const id = c.req.param("id");
  if (!isAccountFactorId(id)) {
    return c.json({ ok: false, error: "invalid_request" }, 400);
  }
  let kind: AccountFactorKind;
  let removed = false;
  if (id === TOTP_FACTOR_ID) {
    kind = "totp";
    removed = await ctx.stores.totpSecrets.delete(principalId);
  } else {
    kind = "passkey";
    const digest = id.slice("pk_".length);
    const own = (await ctx.passkeys.list(principalId)).find(
      (credential) => passkeyDigest(credential.credentialId) === digest,
    );
    removed = own
      ? await ctx.passkeys.remove(principalId, own.credentialId)
      : false;
  }
  if (!removed) return c.json({ ok: false, error: "not_found" }, 404);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "mfa.factor.remove",
    outcome: "succeeded",
    principalId,
    correlationId: c.get("correlationId"),
    targetType: kind === "passkey" ? "passkey_digest" : "totp",
    targetId: id,
    metadata: { action: "mfa.factor.remove", kind },
  });
  return c.json({ ok: true, id, kind });
});
