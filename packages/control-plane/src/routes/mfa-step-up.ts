import { createHash, timingSafeEqual } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { issueTransactionChallenge } from "@opensesame/auth-upstream";
import {
  ACCOUNT_FACTOR_REMOVE_PURPOSE,
  type AccountFactorKind,
  type AccountFactorProof,
  TOTP_FACTOR_ID,
  isAccountFactorId,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { Context } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { Variables } from "../middleware/context.js";
import { incrementSecurityCounter } from "../repos/durable-map.js";
import { webAuthnRpFromPublicUrl } from "./approval-ceremony.js";
import { spendTotpCode } from "./mfa-totp.js";

/**
 * Step-up for removing an account factor (ADR 0146; NIST SP 800-63B
 * §6.1.2.1): a session alone never strips a factor. The delete carries a
 * fresh proof from one of the principal's own factors, verified here, on
 * that request — nothing is minted in between that could be carried to
 * another request.
 *
 * - A passkey proof is an assertion over a WebAuthn challenge issued to this
 *   principal, with the `transaction` purpose and a digest of
 *   (`factor.remove`, principal, factor id). The sign-in verifier refuses a
 *   `transaction` challenge, the Host authorization and interaction
 *   ceremonies refuse this digest, and this route refuses every other
 *   challenge — so an assertion is good for one removal of one factor, once
 *   (the challenge store consumes it), within the challenge's five minutes.
 *   It is always the real verifier (`hostAuthorizationPasskeys`), never the
 *   development stub: this is an assurance decision.
 * - A code is the account authenticator's current one, spent on the shared
 *   step ledger (`./mfa-totp.ts`), so it proves nothing a second time.
 *
 * Every refusal answers 403 or 429, never 401: a client that sees 401 ends
 * the session, and a person asked to prove it is them is still signed in.
 * The failure fences are the ones `/passkey/assert` and `/totp/verify`
 * already keep — per credential and per principal — so a guess spent here
 * counts there, and the other way round.
 */

const MAX_FAILURES = 5;
const MAX_FENCE_ENTRIES = 4096;
const CHALLENGE_TTL_MS = 5 * 60_000;

type RouteContext = Context<{ Variables: Variables }>;

/** The first 32 hex digits of the credential id's SHA-256, as `mfa.ts` fences it. */
export function passkeyDigest(credentialId: string): string {
  return createHash("sha256").update(credentialId).digest("hex").slice(0, 32);
}

export type OwnFactor =
  | { kind: "totp" }
  | { kind: "passkey"; credentialId: string };

/** The caller's factor behind `id`, or null — someone else's reads as none. */
export async function findOwnFactor(
  ctx: AppContext,
  principalId: string,
  id: string,
): Promise<OwnFactor | null> {
  if (id === TOTP_FACTOR_ID) {
    return (await ctx.stores.totpSecrets.has(principalId))
      ? { kind: "totp" }
      : null;
  }
  const digest = id.slice("pk_".length);
  const own = (await ctx.passkeys.list(principalId)).find(
    (credential) => passkeyDigest(credential.credentialId) === digest,
  );
  return own ? { kind: "passkey", credentialId: own.credentialId } : null;
}

/** What a removal challenge commits to: the purpose, the principal, the factor. */
export function factorRemovalDigest(
  principalId: string,
  factorId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        purpose: ACCOUNT_FACTOR_REMOVE_PURPOSE,
        principalId,
        factorId,
      }),
    )
    .digest("hex");
}

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * `/v1/mfa/passkey/authentication-options` with a body naming a purpose:
 * a challenge minted for removing one of the caller's factors. Answers null
 * when the body names no purpose, so the plain sign-in challenge is issued
 * exactly as before.
 */
export async function stepUpOptions(
  c: RouteContext,
  ctx: AppContext,
  principalId: string,
): Promise<Response | null> {
  const body = overlapCast(await c.req.json().catch(() => null));
  if (!isJsonObject(body) || body.purpose === undefined) return null;
  const { purpose, factorId } = body;
  if (
    purpose !== ACCOUNT_FACTOR_REMOVE_PURPOSE ||
    !isAccountFactorId(factorId)
  ) {
    return c.json({ ok: false, error: "invalid_request" }, 400);
  }
  if (!(await findOwnFactor(ctx, principalId, factorId))) {
    return c.json({ ok: false, error: "not_found" }, 404);
  }
  const { challenge, options } = await issueTransactionChallenge(
    ctx.passkeyChallenges,
    webAuthnRpFromPublicUrl(ctx.config.publicUrl),
    {
      principalId,
      transactionDigest: factorRemovalDigest(principalId, factorId),
      ttlMs: CHALLENGE_TTL_MS,
    },
  );
  c.header("cache-control", "no-store");
  return c.json({ ok: true, challenge, options, purpose, factorId });
}

const encoded = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9+/_=-]+$/);

const ProofSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("totp"), code: z.string().regex(/^\d{6}$/) })
    .strict(),
  z
    .object({
      kind: z.literal("passkey"),
      credentialId: encoded,
      clientDataJSON: encoded,
      authenticatorData: encoded,
      signature: encoded,
    })
    .strict(),
]);

const RemovalSchema = z.object({ proof: ProofSchema }).strict();

/** The delete's body: its proof, or why there is none to verify. */
export async function readRemovalProof(
  c: RouteContext,
): Promise<AccountFactorProof | "missing" | "invalid"> {
  const raw = overlapCast(await c.req.json().catch(() => undefined));
  if (raw === undefined || (isJsonObject(raw) && raw.proof === undefined)) {
    return "missing";
  }
  const parsed = RemovalSchema.safeParse(raw);
  return parsed.success ? parsed.data.proof : "invalid";
}

export interface RemovalTarget {
  principalId: string;
  factorId: string;
  kind: AccountFactorKind;
}

/** Record a removal that did not happen, and answer the refusal. */
export async function refuseRemoval(
  c: RouteContext,
  target: RemovalTarget,
  refusal: {
    reason: string;
    proof?: AccountFactorProof["kind"];
    status: 403 | 429;
    error: "step_up_required" | "step_up_failed" | "too_many_attempts";
  },
): Promise<Response> {
  const ctx = c.get("ctx");
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "mfa.factor.remove",
    outcome: "denied",
    principalId: target.principalId,
    correlationId: c.get("correlationId"),
    targetType: target.kind === "passkey" ? "passkey_digest" : "totp",
    targetId: target.factorId,
    metadata: {
      action: "mfa.factor.remove",
      reason: refusal.reason,
      ...(refusal.proof ? { mechanism: refusal.proof } : {}),
    },
  });
  return c.json({ ok: false, error: refusal.error }, refusal.status);
}

async function verifyCode(
  c: RouteContext,
  target: RemovalTarget,
  code: string,
): Promise<Response | null> {
  const ctx = c.get("ctx");
  const failed = (reason: string) =>
    refuseRemoval(c, target, {
      reason,
      proof: "totp",
      status: 403,
      error: "step_up_failed",
    });
  const secret = await ctx.stores.totpSecrets.get(target.principalId);
  if (!secret) return failed("not_enrolled");
  const fenceKey = `totp:${target.principalId}`;
  const prior =
    (await incrementSecurityCounter(ctx.stores.mfaFailures, fenceKey)) - 1;
  if (prior >= MAX_FAILURES) {
    return refuseRemoval(c, target, {
      reason: "too_many_attempts",
      proof: "totp",
      status: 429,
      error: "too_many_attempts",
    });
  }
  const spent = await spendTotpCode(
    ctx.stores.totpSteps,
    target.principalId,
    secret,
    code,
  );
  if (spent !== "accepted") {
    return failed(spent === "replayed" ? "code_replayed" : "bad_code");
  }
  await ctx.stores.mfaFailures.delete(fenceKey);
  return null;
}

function challengeOf(clientDataJSON: string): string | null {
  try {
    const data = overlapCast(
      JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")),
    );
    return isJsonObject(data) && isString(data.challenge)
      ? data.challenge
      : null;
  } catch {
    return null;
  }
}

async function verifyAssertion(
  c: RouteContext,
  target: RemovalTarget,
  proof: Extract<AccountFactorProof, { kind: "passkey" }>,
): Promise<Response | null> {
  const ctx = c.get("ctx");
  const failed = (reason: string) =>
    refuseRemoval(c, target, {
      reason,
      proof: "passkey",
      status: 403,
      error: "step_up_failed",
    });
  if ((await ctx.stores.mfaFailures.size) > MAX_FENCE_ENTRIES) {
    return c.json({ ok: false, error: "rate_limited" }, 429);
  }
  const fenceKey = `passkey:${passkeyDigest(proof.credentialId)}`;
  const prior =
    (await incrementSecurityCounter(ctx.stores.mfaFailures, fenceKey)) - 1;
  if (prior >= MAX_FAILURES) {
    return refuseRemoval(c, target, {
      reason: "too_many_attempts",
      proof: "passkey",
      status: 429,
      error: "too_many_attempts",
    });
  }
  // What the challenge was minted for is read before the verifier spends
  // it: the verifier knows only "transaction", not which one.
  const challenge = challengeOf(proof.clientDataJSON);
  const issued = challenge
    ? await ctx.passkeyChallenges.peek(challenge)
    : undefined;
  if (
    !issued ||
    issued.purpose !== "transaction" ||
    issued.principalId !== target.principalId ||
    !issued.transactionDigest ||
    !digestsEqual(
      issued.transactionDigest,
      factorRemovalDigest(target.principalId, target.factorId),
    )
  ) {
    return failed("challenge_mismatch");
  }
  const verified = await ctx.hostAuthorizationPasskeys.verify({
    credentialId: proof.credentialId,
    clientDataJSON: Buffer.from(proof.clientDataJSON, "base64url"),
    authenticatorData: Buffer.from(proof.authenticatorData, "base64url"),
    signature: Buffer.from(proof.signature, "base64url"),
    expectedPurpose: "transaction",
  });
  if (!verified.ok || verified.principalId !== target.principalId) {
    return failed("assertion_failed");
  }
  await ctx.stores.mfaFailures.delete(fenceKey);
  return null;
}

/** Verify a removal's proof: null when it holds, the refusal otherwise. */
export function verifyRemovalProof(
  c: RouteContext,
  target: RemovalTarget,
  proof: AccountFactorProof,
): Promise<Response | null> {
  return proof.kind === "totp"
    ? verifyCode(c, target, proof.code)
    : verifyAssertion(c, target, proof);
}
