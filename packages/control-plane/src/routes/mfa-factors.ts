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
import {
  findOwnFactor,
  passkeyDigest,
  readRemovalProof,
  refuseRemoval,
  verifyRemovalProof,
} from "./mfa-step-up.js";
import { authenticatedPrincipalId } from "./organizations.js";

export { passkeyDigest } from "./mfa-step-up.js";

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
 * cannot lock anybody out. It does need a step-up (ADR 0146): a fresh proof
 * from one of the caller's own factors, the one being removed included,
 * verified on the delete itself (`./mfa-step-up.ts`), so a stolen session
 * cannot strip a person's second steps. A factor that is not the caller's
 * answers exactly like one that does not exist.
 */
export const mfaFactorRoutes = new Hono<{ Variables: Variables }>();

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
  const kind: AccountFactorKind = id === TOTP_FACTOR_ID ? "totp" : "passkey";
  const target = { principalId, factorId: id, kind };
  const proof = await readRemovalProof(c);
  if (proof === "missing") {
    return refuseRemoval(c, target, {
      reason: "step_up_required",
      status: 403,
      error: "step_up_required",
    });
  }
  if (proof === "invalid") {
    return c.json({ ok: false, error: "invalid_request" }, 400);
  }
  const own = await findOwnFactor(ctx, principalId, id);
  if (!own) return c.json({ ok: false, error: "not_found" }, 404);
  const refused = await verifyRemovalProof(c, target, proof);
  if (refused) return refused;
  const removed =
    own.kind === "totp"
      ? await ctx.stores.totpSecrets.delete(principalId)
      : await ctx.passkeys.remove(principalId, own.credentialId);
  if (!removed) return c.json({ ok: false, error: "not_found" }, 404);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "mfa.factor.remove",
    outcome: "succeeded",
    principalId,
    correlationId: c.get("correlationId"),
    targetType: kind === "passkey" ? "passkey_digest" : "totp",
    targetId: id,
    // `mechanism`: which of the account's factors proved the removal.
    metadata: { action: "mfa.factor.remove", kind, mechanism: proof.kind },
  });
  return c.json({ ok: true, id, kind });
});
