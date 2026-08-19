import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  issueAuthenticationChallenge,
  issueRegistrationChallenge,
  verifyRegistrationAttestation,
} from "@opensesame/auth-upstream";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";

/** Minimal WebAuthn registration response shape (SimpleWebAuthn JSON). */
type RegistrationResponseBody = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string;
};

/** DEV/test TOTP: HMAC-SHA1 truncated to 6 digits (RFC 6238-style). */
function totpCode(
  secretB64: string,
  step = 30,
  digits = 6,
  at = Date.now(),
): string {
  const key = Buffer.from(secretB64, "base64");
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  const otp = bin % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

function totpCodesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function rpFromConfig(publicUrl: string): { rpID: string; origin: string } {
  let hostname = "localhost";
  try {
    hostname = new URL(publicUrl).hostname;
  } catch {
    /* keep default */
  }
  return { rpID: hostname, origin: publicUrl.replace(/\/$/, "") };
}

/**
 * A six-digit code is 10^6 guesses; a passkey assertion is not guessable but its
 * verification is not free. Both get the same small fence.
 */
const MAX_MFA_FAILURES = 5;
const MAX_MFA_FENCE_ENTRIES = 4096;
const MFA_ANON_WINDOW_MS = 60_000;
const MFA_ANON_MAX = 20;
const MFA_ANON_GLOBAL_MAX = 200;
const MFA_ANON_FENCE_ENTRIES = 4096;
const MAX_PASSKEY_FIELD_LENGTH = 16 * 1024;

function pruneMfaFailures(map: Map<string, number>): void {
  if (map.size <= MAX_MFA_FENCE_ENTRIES) return;
  const overflow = map.size - MAX_MFA_FENCE_ENTRIES;
  const keys = [...map.keys()].slice(0, overflow);
  for (const key of keys) map.delete(key);
}

function clientFingerprint(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  return createHash("sha256")
    .update(c.req.header("user-agent") ?? "")
    .update("|")
    .update(c.req.header("origin") ?? c.req.header("x-forwarded-for") ?? "")
    .digest("hex")
    .slice(0, 16);
}

function consumeAnonymousMfaBudget(
  map: Map<string, number[]>,
  fingerprint: string,
  now: number,
): boolean {
  for (const [key, values] of map) {
    const live = values.filter((at) => now - at < MFA_ANON_WINDOW_MS);
    if (live.length === 0) map.delete(key);
    else if (live.length !== values.length) map.set(key, live);
  }
  const global = map.get("__global__") ?? [];
  const client = map.get(fingerprint) ?? [];
  if (global.length >= MFA_ANON_GLOBAL_MAX || client.length >= MFA_ANON_MAX) {
    return false;
  }
  global.push(now);
  client.push(now);
  map.set("__global__", global);
  map.set(fingerprint, client);
  while (map.size > MFA_ANON_FENCE_ENTRIES) {
    const victim = [...map.keys()].find((key) => !key.startsWith("__"));
    if (victim === undefined) break;
    map.delete(victim);
  }
  return true;
}

function shouldAuditAnonymousDenial(
  map: Map<string, number[]>,
  now: number,
): boolean {
  const last = map.get("__audit__")?.[0];
  if (last !== undefined && now - last < MFA_ANON_WINDOW_MS) return false;
  map.set("__audit__", [now]);
  return true;
}

/**
 * Record a refused factor.
 *
 * Almost every audit event in this service is a success, which is the one shape
 * of trail that cannot show an attack: five failed codes followed by one success
 * reads as a single login. A denial is the event worth keeping.
 */
async function auditMfaDenial(
  ctx: AppContext,
  input: {
    eventType: string;
    reason: string;
    principalId?: string;
    correlationId?: string;
    targetType?: string;
    targetId?: string;
  },
): Promise<void> {
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: input.eventType,
    outcome: "denied",
    ...(input.principalId !== undefined
      ? { principalId: input.principalId }
      : {}),
    ...(input.correlationId !== undefined
      ? { correlationId: input.correlationId }
      : {}),
    ...(input.targetType !== undefined ? { targetType: input.targetType } : {}),
    ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
    metadata: { action: input.eventType, reason: input.reason },
  });
}

export const mfaRoutes = new Hono<{ Variables: Variables }>();

/** Issue a one-time WebAuthn registration challenge (required in production). */
mfaRoutes.post(
  "/passkey/registration-options",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const rp = rpFromConfig(ctx.config.publicUrl);
    const { challenge, options } = await issueRegistrationChallenge(
      ctx.passkeyChallenges,
      rp,
      { principalId },
    );
    return c.json({ ok: true, challenge, options });
  },
);

/**
 * Register a passkey.
 * - Dev (`allowDevDefaults`): accepts raw credentialId/publicKey stubs.
 * - Production: requires a RegistrationResponseJSON verified against a prior
 *   `/passkey/registration-options` challenge (attestation ceremony).
 */
mfaRoutes.post("/passkey/register", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const body = await c.req.json<
    | {
        credentialId: string;
        publicKey: string;
        counter?: number;
      }
    | { response: RegistrationResponseBody }
  >();

  if (!ctx.config.allowDevDefaults) {
    if (!("response" in body) || !body.response) {
      return c.json(
        {
          error: "registration_attestation_required",
          hint: "POST /v1/mfa/passkey/registration-options then submit response",
        },
        400,
      );
    }
    const rp = rpFromConfig(ctx.config.publicUrl);
    const verified = await verifyRegistrationAttestation(
      ctx.passkeyChallenges,
      rp,
      body.response as Parameters<typeof verifyRegistrationAttestation>[2],
      principalId,
    );
    if (!verified) {
      return c.json({ error: "registration_verification_failed" }, 401);
    }
    const cred = await ctx.passkeys.register(principalId, {
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      counter: verified.counter,
    });
    return c.json({
      ok: true,
      credentialId: cred.credentialId,
      principalId: cred.principalId,
    });
  }

  if (!("credentialId" in body) || !body.credentialId || !body.publicKey) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const cred = await ctx.passkeys.register(principalId, {
    credentialId: body.credentialId,
    publicKey: Buffer.from(body.publicKey, "base64"),
    counter: body.counter ?? 0,
  });
  return c.json({
    ok: true,
    credentialId: cred.credentialId,
    principalId: cred.principalId,
  });
});

/** Issue a one-time WebAuthn challenge (required for production assert). */
mfaRoutes.post(
  "/passkey/authentication-options",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const rp = rpFromConfig(ctx.config.publicUrl);
    const { challenge, options } = await issueAuthenticationChallenge(
      ctx.passkeyChallenges,
      rp,
      { principalId },
    );
    return c.json({ ok: true, challenge, options });
  },
);

mfaRoutes.post("/passkey/assert", async (c) => {
  const ctx = c.get("ctx");
  const now = ctx.clock().getTime();
  const fingerprint = clientFingerprint(c);
  if (!consumeAnonymousMfaBudget(ctx.stores.mfaAnon, fingerprint, now)) {
    return c.json({ ok: false, error: "rate_limited" }, 429);
  }
  const body = await c.req.json<{
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  }>();
  if (
    !body.credentialId ||
    !body.signature ||
    [
      body.credentialId,
      body.clientDataJSON,
      body.authenticatorData,
      body.signature,
    ].some(
      (value) =>
        typeof value !== "string" || value.length > MAX_PASSKEY_FIELD_LENGTH,
    )
  ) {
    return c.json({ error: "invalid_request" }, 400);
  }
  pruneMfaFailures(ctx.stores.mfaFailures);
  const credentialDigest = createHash("sha256")
    .update(body.credentialId)
    .digest("hex")
    .slice(0, 32);
  const fenceKey = `passkey:${credentialDigest}`;
  const prior = ctx.stores.mfaFailures.get(fenceKey) ?? 0;
  if (prior >= MAX_MFA_FAILURES) {
    if (shouldAuditAnonymousDenial(ctx.stores.mfaAnon, now)) {
      await auditMfaDenial(ctx, {
        eventType: "mfa.passkey.assert",
        reason: "too_many_attempts",
        correlationId: c.get("correlationId"),
        targetType: "passkey_digest",
        targetId: credentialDigest,
      });
    }
    return c.json({ ok: false, error: "too_many_attempts" }, 429);
  }
  ctx.stores.mfaFailures.set(fenceKey, prior + 1);
  const result = await ctx.passkeys.verify({
    credentialId: body.credentialId,
    clientDataJSON: Buffer.from(body.clientDataJSON ?? "", "base64"),
    authenticatorData: Buffer.from(body.authenticatorData ?? "", "base64"),
    signature: Buffer.from(body.signature, "base64"),
  });
  if (!result.ok) {
    if (shouldAuditAnonymousDenial(ctx.stores.mfaAnon, now)) {
      await auditMfaDenial(ctx, {
        eventType: "mfa.passkey.assert",
        reason: "assertion_failed",
        correlationId: c.get("correlationId"),
        targetType: "passkey_digest",
        targetId: credentialDigest,
      });
    }
    return c.json({ ok: false }, 401);
  }
  ctx.stores.mfaFailures.delete(fenceKey);
  return c.json({ ok: true, principalId: result.principalId });
});

/**
 * DEV/test TOTP only — not a production MFA factor.
 * Prefer WebAuthn passkeys (`/passkey/*`) when `allowDevDefaults` is false.
 */
mfaRoutes.post("/totp/enroll", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  if (!ctx.config.allowDevDefaults) {
    return c.json(
      {
        error: "totp_dev_only",
        hint: "Use /v1/mfa/passkey/registration-options for production MFA",
      },
      403,
    );
  }
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const secret = randomBytes(20);
  const secretB64 = secret.toString("base64");
  ctx.stores.totpSecrets.set(principalId, secretB64);
  const otpauthUrl = `otpauth://totp/OpenSesame:${encodeURIComponent(principalId)}?secret=${secret.toString("hex")}&issuer=OpenSesame`;
  return c.json({
    ok: true,
    secret: secretB64,
    otpauthUrl,
    note: "DEV: verify with /v1/mfa/totp/verify using the computed code",
  });
});

mfaRoutes.post("/totp/verify", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  if (!ctx.config.allowDevDefaults) {
    return c.json(
      {
        error: "totp_dev_only",
        hint: "Use /v1/mfa/passkey/assert for production MFA",
      },
      403,
    );
  }
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const body = await c.req.json<{ code: string; principalId?: string }>();
  if (body.principalId && body.principalId !== principalId) {
    return c.json({ ok: false, error: "principal_mismatch" }, 403);
  }
  const secret = ctx.stores.totpSecrets.get(principalId);
  if (!secret) return c.json({ ok: false, error: "not_enrolled" }, 404);
  const fenceKey = `totp:${principalId}`;
  const prior = ctx.stores.mfaFailures.get(fenceKey) ?? 0;
  if (prior >= MAX_MFA_FAILURES) {
    await auditMfaDenial(ctx, {
      eventType: "mfa.totp.verify",
      reason: "too_many_attempts",
      principalId,
      correlationId: c.get("correlationId"),
    });
    return c.json({ ok: false, error: "too_many_attempts" }, 429);
  }
  ctx.stores.mfaFailures.set(fenceKey, prior + 1);
  const expected = totpCode(secret);
  const ok = totpCodesEqual(body.code ?? "", expected);
  if (!ok) {
    await auditMfaDenial(ctx, {
      eventType: "mfa.totp.verify",
      reason: "bad_code",
      principalId,
      correlationId: c.get("correlationId"),
    });
    return c.json({ ok }, 401);
  }
  ctx.stores.mfaFailures.delete(fenceKey);
  return c.json({ ok }, 200);
});

export { totpCode };
